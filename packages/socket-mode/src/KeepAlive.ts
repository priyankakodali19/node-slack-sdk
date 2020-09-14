import { EventEmitter } from 'eventemitter3';
import { SocketModeClient } from './SocketModeClient';
import { LogLevel, Logger, getLogger } from './logger';
import { ErrorCode, CodedError } from './errors';

export interface KeepAliveOptions {
  logger?: Logger;
  logLevel?: LogLevel;
  /** How long (in ms) to wait before sending a ping message to keep the connection alive */
  clientPingTimeout?: number;
  /** How long (in ms) to wait for the acknowledgement of a ping message before considering the connection dead */
  serverPongTimeout?: number; // NOTE: this must be less than clientPingTimeout
}

/**
 * An object that monitors activity in an SocketModeClient and generates ping events in an effort to keep its websocket
 * connection alive. In cases where the websocket connection seems unresponsive, this object emits a
 * `recommend_reconnect` event. That event should be handled by tearing down the websocket connection and
 * opening a new one.
 */
export class KeepAlive extends EventEmitter {

  /**
   * The amount of time in milliseconds to wait after the last outgoing message from the client to generate a ping
   * message.
   */
  private clientPingTimeout: number;
  /**
   * The amount of time in milliseconds to wait after a ping message for the server to respond with a message that
   * replies to that ping (a pong) or some message after that.
   */
  private serverPongTimeout: number;

  /**
   * The Socket Mode Client to monitor.
   */
  private client?: SocketModeClient;

  /**
   * A timer for when to send the next ping if no other outgoing message is sent.
   */
  private pingTimer?: NodeJS.Timer;

  /**
   * A timer for when to stop listening for an incoming event that acknowledges the ping (counts as a pong)
   */
  private pongTimer?: NodeJS.Timer;

  /**
   * The message ID of the latest ping sent, or undefined is there hasn't been one sent.
   */
  private lastPing?: number;

  /**
   * The name used to prefix all logging generated from this object
   */
  private static loggerName = 'KeepAlive';

  /**
   * This object's logger instance
   */
  private logger: Logger;

  /**
   * Flag that indicates whether this object is still monitoring.
   */
  public isMonitoring: boolean;

  /**
   * Flag that indicates whether recommend_reconnect event has been emitted and stop() has not been called.
   */
  public recommendReconnect: boolean;

  constructor({
    clientPingTimeout = 6000,
    serverPongTimeout = 4000,
    logger = undefined,
    logLevel = LogLevel.INFO,
  }: KeepAliveOptions = {}) {
    super();

    this.clientPingTimeout = clientPingTimeout;
    this.serverPongTimeout = serverPongTimeout;

    if (this.serverPongTimeout >= this.clientPingTimeout) {
      const error = new Error('Client ping timeout must be less than server pong timeout');
      (error as CodedError).code = ErrorCode.KeepAliveConfigError;
      throw error;
    }

    this.isMonitoring = false;
    this.recommendReconnect = false;

    // Logging
    this.logger = getLogger(KeepAlive.loggerName, logLevel, logger);
  }

  /**
   * Start monitoring the Socket Mode Client.
   * This method should only be called after the client's websocket is already open.
   */
  public start(client: SocketModeClient): void {
    this.logger.debug('start monitoring');

    if (!client.connected) {
      const error = new Error('');
      (error as CodedError).code = ErrorCode.KeepAliveClientNotConnected;
      throw error;
    }

    this.client = client;
    this.isMonitoring = true;
    this.client.on('ping', this.setPingTimer, this);
    this.setPingTimer();
  }

  /**
   * Stop monitoring the Socket Mode Client. This method should be called after the `recommend_reconnect` event is
   * emitted and the client's weboscket is closed. In order to start monitoring the client again, start() needs to
   * be called again after that.
   */
  public stop(): void {
    this.logger.debug('stop monitoring');

    this.clearPreviousPingTimer();
    this.clearPreviousPongTimer();
    if (this.client !== undefined) {
      this.client.off('outgoing_message', this.setPingTimer);
      this.client.off('slack_event', this.attemptAcknowledgePong);
    }
    this.lastPing = this.client = undefined;
    this.recommendReconnect = this.isMonitoring = false;
  }

  /**
   * Clears the ping timer if its set, otherwise this is a noop.
   */
  private clearPreviousPingTimer(): void {
    if (this.pingTimer !== undefined) {
      clearTimeout(this.pingTimer);
      delete this.pingTimer;
    }
  }

  /**
   * Sets the ping timer (including clearing any previous one).
   */
  private setPingTimer(): void {
    // if there's already an unacknowledged ping, we don't need to set up a timer for another to be sent
    if (this.lastPing !== undefined) {
      return;
    }

    this.logger.debug('setting ping timer');

    this.clearPreviousPingTimer();
    console.log(this.clientPingTimeout);
    this.pingTimer = setTimeout(this.sendPing.bind(this), this.clientPingTimeout);
  }

  /**
   * Sends a ping and manages the timer to wait for a pong.
   */
  private sendPing(): void {
    try {
      if (this.client === undefined || this.client.websocket === undefined) {
        if (!this.isMonitoring) {
          // if monitoring stopped before the ping timer fires, its safe to return
          this.logger.debug('stopped monitoring before ping timer fired');
          return;
        }
        const error = new Error('no client found');
        (error as CodedError).code = ErrorCode.KeepAliveInconsistentState;
        throw error;
      }
      this.logger.debug('ping timer expired, sending ping');
      this.client.websocket.ping('ping', false, () => {
        if (this.client === undefined) {
          if (!this.isMonitoring) {
              // if monitoring stopped before the ping is sent, its safe to return
            this.logger.debug('stopped monitoring before outgoing ping message was finished');
            return;
          }
          const error = new Error('no client found');
          (error as CodedError).code = ErrorCode.KeepAliveInconsistentState;
          throw error;
        }

        this.logger.debug('setting pong timer');

        this.pongTimer = setTimeout(
            () => {
              if (this.client === undefined) {
                // if monitoring stopped before the pong timer fires, its safe to return
                if (!this.isMonitoring) {
                  this.logger.debug('stopped monitoring before pong timer fired');
                  return;
                }
                const error = new Error('no client found');
                (error as CodedError).code = ErrorCode.KeepAliveInconsistentState;
                throw error;
              }

              // no pong received to acknowledge the last ping within the serverPongTimeout
              this.logger.debug('pong timer expired, recommend reconnect');
              this.recommendReconnect = true;
              this.emit('recommend_reconnect');
            },
            this.serverPongTimeout,
          );

        this.client.on('pong', this.attemptAcknowledgePong, this);
      })
    } catch (error) {
      this.logger.error(`Unhandled error: ${error.message}. Please report to @slack/socket-mode package maintainers.`);
    }
  }

  /**
   * Clears the pong timer if its set, otherwise this is a noop.
   */
  private clearPreviousPongTimer(): void {
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer);
    }
  }

  /**
   * Determines if a giving incoming event can be treated as an acknowledgement for the outstanding ping, and then
   * clears the ping if so.
   * @param event incoming slack event
   */
  private attemptAcknowledgePong(_type: string, event: { [key: string]: unknown }): void {
    console.log('attempting Ack pong');
    if (this.client === undefined) {
      const error = new Error('no client found');
      (error as CodedError).code = ErrorCode.KeepAliveInconsistentState;
      throw error;
    }

    if (this.lastPing !== undefined) {
      // this message is a reply that acks the previous ping, clear the last ping
      this.logger.debug('received pong, clearing pong timer');
      delete this.lastPing;

      // signal that this pong is done being handled
      this.clearPreviousPongTimer();
    }
  }
}
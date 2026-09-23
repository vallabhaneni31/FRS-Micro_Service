import axios from 'axios';
import axiosRetry from 'axios-retry';
import EventEmitter from 'events';

/**
 * Custom, secure, lightweight Circuit Breaker to eliminate unmaintained third-party dependencies.
 */
class CustomCircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.volumeThreshold || 5;
    this.cooldownDuration = options.timeoutDuration || 5000;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF-OPEN
    this.failureCount = 0;
    this.nextAttemptTime = 0;
  }

  async run(action, fallback) {
    if (this.state === 'OPEN') {
      if (Date.now() > this.nextAttemptTime) {
        this.state = 'HALF-OPEN';
      } else {
        return fallback();
      }
    }

    const success = () => {
      this.failureCount = 0;
      this.state = 'CLOSED';
    };

    const failure = () => {
      this.failureCount++;
      if (this.failureCount >= this.failureThreshold) {
        this.state = 'OPEN';
        this.nextAttemptTime = Date.now() + this.cooldownDuration;
      }
    };

    try {
      await action(success, failure);
    } catch (err) {
      // Action is expected to catch and reject itself
    }
  }
}

/**
 * HTTPClient - axios wrapper with retry + circuit breaker + simple queuing.
 */
class HTTPClient extends EventEmitter {
  constructor() {
    super();
    this.client = axios.create({
      timeout: Number(process.env.HTTP_TIMEOUT_MS || 5000),
    });

    this.maxRetries = Number(process.env.HTTP_MAX_RETRIES || 3);
    this.baseDelayMs = Number(process.env.HTTP_RETRY_DELAY_MS || 250);

    axiosRetry(this.client, {
      retries: this.maxRetries,
      retryDelay: (retryCount) => this.baseDelayMs * retryCount,
      retryCondition: (error) =>
        !error.response || error.response.status >= 500,
    });

    this.breaker = new CustomCircuitBreaker({
      timeoutDuration: 5000,
      volumeThreshold: 5,
    });

    this.queue = [];
    this.processing = false;
  }

  /**
   * @template T
   * @param {import('axios').AxiosRequestConfig} config
   * @returns {Promise<import('axios').AxiosResponse<T>>}
   */
  async request(config) {
    return new Promise((resolve, reject) => {
      this.breaker.run(
        async (success, failure) => {
          try {
            const res = await this.client.request(config);
            this.emit('success', { config, status: res.status });
            success();
            resolve(res);
          } catch (err) {
            this.emit('error', { config, error: err });
            failure();
            reject(err);
          }
        },
        () => {
          const error = new Error('HTTP circuit breaker open');
          this.emit('rejected', { config, error });
          reject(error);
        },
      );
    });
  }
}

const httpClient = new HTTPClient();
export default httpClient;


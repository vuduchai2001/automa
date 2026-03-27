/**
 * Worker Internal API Client
 *
 * Sends artifact logs, action logs, workflow logs, and finish-job signals
 * to the worker's internal HTTP API when running in worker-triggered mode.
 *
 * Base URL: http://127.0.0.1:{internalApiPort}
 * Auth: Authorization: Bearer <secret> (if configured)
 */

const TAG = '[WorkerAPI]';

class WorkerApiClient {
  /**
   * @param {number} port
   * @returns {string}
   */
  static baseUrl(port) {
    return `http://localhost:${port}`;
  }

  /**
   * @param {string|null} secret
   * @returns {Object}
   */
  static headers(secret) {
    const h = { 'Content-Type': 'application/json' };
    if (secret) {
      h.Authorization = `Bearer ${secret}`;
    }
    return h;
  }

  /**
   * POST /artifact-log
   * @param {Object} ctx - { jobId, actionIndex, internalApiPort, internalApiSecret }
   * @param {Object} artifact - { artifactType, artifactName, dataBase64, mimeType, metadata }
   * @returns {Promise<Object>}
   */
  static async sendArtifactLog(ctx, artifact) {
    const url = `${this.baseUrl(ctx.internalApiPort)}/artifact-log`;

    const payload = {
      job_id: ctx.jobId,
      action_index: typeof ctx.actionIndex === 'number' ? ctx.actionIndex : 0,
      artifact_type: artifact.artifactType,
      artifact_name: artifact.artifactName,
      data_base64: artifact.dataBase64,
      mime_type: artifact.mimeType,
      captured_at: new Date().toISOString(),
      metadata: artifact.metadata || {},
    };

    // eslint-disable-next-line no-console
    console.log(TAG, 'POST /artifact-log', {
      url,
      jobId: ctx.jobId,
      artifactType: artifact.artifactType,
      artifactName: artifact.artifactName,
      mimeType: artifact.mimeType,
      dataSize: artifact.dataBase64?.length || 0,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers(ctx.internalApiSecret),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error(TAG, 'artifact-log FAILED', response.status, text);
        throw new Error(`artifact-log HTTP ${response.status}: ${text}`);
      }

      const result = await response.json();
      // eslint-disable-next-line no-console
      console.log(TAG, 'artifact-log OK', result);
      return result;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(TAG, 'artifact-log ERROR', error.message);
      throw error;
    }
  }

  /**
   * POST /action-log
   * @param {Object} ctx - workerContext
   * @param {Object} logData - { logLevel, logType, message, logData }
   * @returns {Promise<Object>}
   */
  static async sendActionLog(ctx, logData) {
    const url = `${this.baseUrl(ctx.internalApiPort)}/action-log`;

    const payload = {
      job_id: ctx.jobId,
      action_index: typeof ctx.actionIndex === 'number' ? ctx.actionIndex : 0,
      log_level: logData.logLevel || 'info',
      log_type: logData.logType || 'general',
      message: logData.message || '',
      log_data: logData.logData || {},
    };

    // eslint-disable-next-line no-console
    console.log(TAG, 'POST /action-log', {
      url,
      jobId: ctx.jobId,
      logLevel: payload.log_level,
      message: payload.message,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers(ctx.internalApiSecret),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error(TAG, 'action-log FAILED', response.status, text);
        throw new Error(`action-log HTTP ${response.status}: ${text}`);
      }

      const result = await response.json();
      // eslint-disable-next-line no-console
      console.log(TAG, 'action-log OK', result);
      return result;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(TAG, 'action-log ERROR', error.message);
      throw error;
    }
  }

  /**
   * POST /workflow-log
   * @param {Object} ctx - workerContext
   * @param {Object} logData - { logLevel, logType, message, logData }
   * @returns {Promise<Object>}
   */
  static async sendWorkflowLog(ctx, logData) {
    const url = `${this.baseUrl(ctx.internalApiPort)}/workflow-log`;

    const payload = {
      job_id: ctx.jobId,
      action_index: typeof ctx.actionIndex === 'number' ? ctx.actionIndex : 0,
      log_level: logData.logLevel || 'info',
      log_type: logData.logType || 'workflow',
      message: logData.message || '',
      log_data: logData.logData || {},
    };

    // eslint-disable-next-line no-console
    console.log(TAG, 'POST /workflow-log', {
      url,
      jobId: ctx.jobId,
      logLevel: payload.log_level,
      message: payload.message,
      logData: payload.log_data,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers(ctx.internalApiSecret),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error(TAG, 'workflow-log FAILED', response.status, text);
        throw new Error(`workflow-log HTTP ${response.status}: ${text}`);
      }

      const result = await response.json();
      // eslint-disable-next-line no-console
      console.log(TAG, 'workflow-log OK', result);
      return result;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(TAG, 'workflow-log ERROR', error.message);
      throw error;
    }
  }

  /**
   * POST /finish-job
   * @param {Object} ctx - workerContext
   * @returns {Promise<Object>}
   */
  static async sendFinishJob(ctx) {
    const url = `${this.baseUrl(ctx.internalApiPort)}/finish-job`;

    const payload = {
      job_id: ctx.jobId,
    };

    // eslint-disable-next-line no-console
    console.log(TAG, 'POST /finish-job', { url, jobId: ctx.jobId });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.headers(ctx.internalApiSecret),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error(TAG, 'finish-job FAILED', response.status, text);
        throw new Error(`finish-job HTTP ${response.status}: ${text}`);
      }

      const result = await response.json();
      // eslint-disable-next-line no-console
      console.log(TAG, 'finish-job OK', result);
      return result;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(TAG, 'finish-job ERROR', error.message);
      throw error;
    }
  }
}

export default WorkerApiClient;

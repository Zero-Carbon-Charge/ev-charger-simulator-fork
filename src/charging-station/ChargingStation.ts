import { AuthorizationStatus, AuthorizeRequest, AuthorizeResponse, StartTransactionRequest, StartTransactionResponse, StopTransactionReason, StopTransactionRequest, StopTransactionResponse } from '../types/ocpp/1.6/Transaction';
import { AvailabilityType, BootNotificationRequest, ChangeAvailabilityRequest, ChangeConfigurationRequest, ClearChargingProfileRequest, GetConfigurationRequest, HeartbeatRequest, IncomingRequestCommand, RemoteStartTransactionRequest, RemoteStopTransactionRequest, RequestCommand, ResetRequest, SetChargingProfileRequest, StatusNotificationRequest, UnlockConnectorRequest } from '../types/ocpp/1.6/Requests';
import { BootNotificationResponse, ChangeAvailabilityResponse, ChangeConfigurationResponse, ClearChargingProfileResponse, DefaultResponse, GetConfigurationResponse, HeartbeatResponse, RegistrationStatus, SetChargingProfileResponse, StatusNotificationResponse, UnlockConnectorResponse } from '../types/ocpp/1.6/RequestResponses';
import { ChargingProfile, ChargingProfilePurposeType } from '../types/ocpp/1.6/ChargingProfile';
import ChargingStationConfiguration, { ConfigurationKey } from '../types/ChargingStationConfiguration';
import ChargingStationTemplate, { PowerOutType, VoltageOut } from '../types/ChargingStationTemplate';
import Connectors, { Connector } from '../types/Connectors';
import { MeterValue, MeterValueLocation, MeterValueMeasurand, MeterValuePhase, MeterValueUnit, MeterValuesRequest, MeterValuesResponse, SampledValue } from '../types/ocpp/1.6/MeterValues';
import { PerformanceObserver, performance } from 'perf_hooks';
import Requests, { IncomingRequest, Request } from '../types/ocpp/Requests';
import WebSocket, { MessageEvent } from 'ws';

import AutomaticTransactionGenerator from './AutomaticTransactionGenerator';
import { ChargePointErrorCode } from '../types/ocpp/1.6/ChargePointErrorCode';
import { ChargePointStatus } from '../types/ocpp/1.6/ChargePointStatus';
import ChargingStationInfo from '../types/ChargingStationInfo';
import Configuration from '../utils/Configuration';
import Constants from '../utils/Constants';
import ElectricUtils from '../utils/ElectricUtils';
import { ErrorType } from '../types/ocpp/ErrorType';
import MeasurandValues from '../types/MeasurandValues';
import { MessageType } from '../types/ocpp/MessageType';
import { OCPPConfigurationKey } from '../types/ocpp/Configuration';
import OCPPError from './OcppError';
import { StandardParametersKey } from '../types/ocpp/1.6/Configuration';
import Statistics from '../utils/Statistics';
import Utils from '../utils/Utils';
import { WebSocketCloseEventStatusCode } from '../types/WebSocket';
import crypto from 'crypto';
import fs from 'fs';
import logger from '../utils/Logger';

export default class ChargingStation {
  public stationInfo: ChargingStationInfo;
  public connectors: Connectors;
  public statistics: Statistics;
  private index: number;
  private stationTemplateFile: string;
  private bootNotificationRequest: BootNotificationRequest;
  private bootNotificationResponse: BootNotificationResponse;
  private configuration: ChargingStationConfiguration;
  private connectorsConfigurationHash: string;
  private supervisionUrl: string;
  private wsConnectionUrl: string;
  private wsConnection: WebSocket;
  private hasStopped: boolean;
  private hasSocketRestarted: boolean;
  private autoReconnectRetryCount: number;
  private requests: Requests;
  private messageQueue: string[];
  private automaticTransactionGeneration: AutomaticTransactionGenerator;
  private authorizedTags: string[];
  private heartbeatSetInterval: NodeJS.Timeout;
  private webSocketPingSetInterval: NodeJS.Timeout;
  private performanceObserver: PerformanceObserver;

  constructor(index: number, stationTemplateFile: string) {
    this.index = index;
    this.stationTemplateFile = stationTemplateFile;
    this.connectors = {} as Connectors;
    this._initialize();

    this.hasStopped = false;
    this.hasSocketRestarted = false;
    this.autoReconnectRetryCount = 0;

    this.requests = {} as Requests;
    this.messageQueue = [] as string[];

    this.authorizedTags = this._getAuthorizedTags();
  }

  _getChargingStationId(stationTemplate: ChargingStationTemplate): string {
    // In case of multiple instances: add instance index to charging station id
    let instanceIndex = process.env.CF_INSTANCE_INDEX ? process.env.CF_INSTANCE_INDEX : 0;
    instanceIndex = instanceIndex > 0 ? instanceIndex : '';
    const idSuffix = stationTemplate.nameSuffix ? stationTemplate.nameSuffix : '';
    return stationTemplate.fixedName ? stationTemplate.baseName : stationTemplate.baseName + '-' + instanceIndex.toString() + ('000000000' + this.index.toString()).substr(('000000000' + this.index.toString()).length - 4) + idSuffix;
  }

  _buildStationInfo(): ChargingStationInfo {
    let stationTemplateFromFile: ChargingStationTemplate;
    try {
      // Load template file
      const fileDescriptor = fs.openSync(this.stationTemplateFile, 'r');
      stationTemplateFromFile = JSON.parse(fs.readFileSync(fileDescriptor, 'utf8')) as ChargingStationTemplate;
      fs.closeSync(fileDescriptor);
    } catch (error) {
      logger.error('Template file ' + this.stationTemplateFile + ' loading error: %j', error);
      throw error;
    }
    const stationInfo: ChargingStationInfo = stationTemplateFromFile || {} as ChargingStationInfo;
    if (!Utils.isEmptyArray(stationTemplateFromFile.power)) {
      stationTemplateFromFile.power = stationTemplateFromFile.power as number[];
      stationInfo.maxPower = stationTemplateFromFile.power[Math.floor(Math.random() * stationTemplateFromFile.power.length)];
    } else {
      stationInfo.maxPower = stationTemplateFromFile.power as number;
    }
    stationInfo.chargingStationId = this._getChargingStationId(stationTemplateFromFile);
    stationInfo.resetTime = stationTemplateFromFile.resetTime ? stationTemplateFromFile.resetTime * 1000 : Constants.CHARGING_STATION_DEFAULT_RESET_TIME;
    return stationInfo;
  }

  _initialize(): void {
    this.stationInfo = this._buildStationInfo();
    this.bootNotificationRequest = {
      chargePointModel: this.stationInfo.chargePointModel,
      chargePointVendor: this.stationInfo.chargePointVendor,
      ...!Utils.isUndefined(this.stationInfo.chargeBoxSerialNumberPrefix) && { chargeBoxSerialNumber: this.stationInfo.chargeBoxSerialNumberPrefix },
      ...!Utils.isUndefined(this.stationInfo.firmwareVersion) && { firmwareVersion: this.stationInfo.firmwareVersion },
    };
    this.configuration = this._getTemplateChargingStationConfiguration();
    this.supervisionUrl = this._getSupervisionURL();
    this.wsConnectionUrl = this.supervisionUrl + '/' + this.stationInfo.chargingStationId;
    // Build connectors if needed
    const maxConnectors = this._getMaxNumberOfConnectors();
    if (maxConnectors <= 0) {
      logger.warn(`${this._logPrefix()} Charging station template ${this.stationTemplateFile} with ${maxConnectors} connectors`);
    }
    const templateMaxConnectors = this._getTemplateMaxNumberOfConnectors();
    if (templateMaxConnectors <= 0) {
      logger.warn(`${this._logPrefix()} Charging station template ${this.stationTemplateFile} with no connector configuration`);
    }
    if (!this.stationInfo.Connectors[0]) {
      logger.warn(`${this._logPrefix()} Charging station template ${this.stationTemplateFile} with no connector Id 0 configuration`);
    }
    // Sanity check
    if (maxConnectors > (this.stationInfo.Connectors[0] ? templateMaxConnectors - 1 : templateMaxConnectors) && !this.stationInfo.randomConnectors) {
      logger.warn(`${this._logPrefix()} Number of connectors exceeds the number of connector configurations in template ${this.stationTemplateFile}, forcing random connector configurations affectation`);
      this.stationInfo.randomConnectors = true;
    }
    const connectorsConfigHash = crypto.createHash('sha256').update(JSON.stringify(this.stationInfo.Connectors) + maxConnectors.toString()).digest('hex');
    // FIXME: Handle shrinking the number of connectors
    if (!this.connectors || (this.connectors && this.connectorsConfigurationHash !== connectorsConfigHash)) {
      this.connectorsConfigurationHash = connectorsConfigHash;
      // Add connector Id 0
      let lastConnector = '0';
      for (lastConnector in this.stationInfo.Connectors) {
        if (Utils.convertToInt(lastConnector) === 0 && this._getUseConnectorId0() && this.stationInfo.Connectors[lastConnector]) {
          this.connectors[lastConnector] = Utils.cloneObject<Connector>(this.stationInfo.Connectors[lastConnector]);
          this.connectors[lastConnector].availability = AvailabilityType.OPERATIVE;
          if (Utils.isUndefined(this.connectors[lastConnector]?.chargingProfiles)) {
            this.connectors[lastConnector].chargingProfiles = [];
          }
        }
      }
      // Generate all connectors
      if ((this.stationInfo.Connectors[0] ? templateMaxConnectors - 1 : templateMaxConnectors) > 0) {
        for (let index = 1; index <= maxConnectors; index++) {
          const randConnectorID = this.stationInfo.randomConnectors ? Utils.getRandomInt(Utils.convertToInt(lastConnector), 1) : index;
          this.connectors[index] = Utils.cloneObject<Connector>(this.stationInfo.Connectors[randConnectorID]);
          this.connectors[index].availability = AvailabilityType.OPERATIVE;
          if (Utils.isUndefined(this.connectors[lastConnector]?.chargingProfiles)) {
            this.connectors[index].chargingProfiles = [];
          }
        }
      }
    }
    // Avoid duplication of connectors related information
    delete this.stationInfo.Connectors;
    // Initialize transaction attributes on connectors
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && !this.getConnector(Utils.convertToInt(connector)).transactionStarted) {
        this._initTransactionOnConnector(Utils.convertToInt(connector));
      }
    }
    // OCPP parameters
    this._addConfigurationKey(StandardParametersKey.NumberOfConnectors, this._getNumberOfConnectors().toString(), true);
    if (!this._getConfigurationKey(StandardParametersKey.MeterValuesSampledData)) {
      this._addConfigurationKey(StandardParametersKey.MeterValuesSampledData, MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER);
    }
    this.stationInfo.powerDivider = this._getPowerDivider();
    if (this.getEnableStatistics()) {
      this.statistics = new Statistics(this.stationInfo.chargingStationId);
      this.performanceObserver = new PerformanceObserver((list) => {
        const entry = list.getEntries()[0];
        this.statistics.logPerformance(entry, Constants.ENTITY_CHARGING_STATION);
        this.performanceObserver.disconnect();
      });
    }
  }

  _logPrefix(): string {
    return Utils.logPrefix(` ${this.stationInfo.chargingStationId}:`);
  }

  _isWebSocketOpen(): boolean {
    return this.wsConnection?.readyState === WebSocket.OPEN;
  }

  _isRegistered(): boolean {
    return this.bootNotificationResponse?.status === RegistrationStatus.ACCEPTED;
  }

  _getTemplateChargingStationConfiguration(): ChargingStationConfiguration {
    return this.stationInfo.Configuration ? this.stationInfo.Configuration : {} as ChargingStationConfiguration;
  }

  _getAuthorizationFile(): string {
    return this.stationInfo.authorizationFile && this.stationInfo.authorizationFile;
  }

  _getUseConnectorId0(): boolean {
    return !Utils.isUndefined(this.stationInfo.useConnectorId0) ? this.stationInfo.useConnectorId0 : true;
  }

  _getAuthorizedTags(): string[] {
    let authorizedTags: string[] = [];
    const authorizationFile = this._getAuthorizationFile();
    if (authorizationFile) {
      try {
        // Load authorization file
        const fileDescriptor = fs.openSync(authorizationFile, 'r');
        authorizedTags = JSON.parse(fs.readFileSync(fileDescriptor, 'utf8')) as string[];
        fs.closeSync(fileDescriptor);
      } catch (error) {
        logger.error(this._logPrefix() + ' Authorization file ' + authorizationFile + ' loading error: %j', error);
        throw error;
      }
    } else {
      logger.info(this._logPrefix() + ' No authorization file given in template file ' + this.stationTemplateFile);
    }
    return authorizedTags;
  }

  getRandomTagId(): string {
    const index = Math.floor(Math.random() * this.authorizedTags.length);
    return this.authorizedTags[index];
  }

  hasAuthorizedTags(): boolean {
    return !Utils.isEmptyArray(this.authorizedTags);
  }

  getEnableStatistics(): boolean {
    return !Utils.isUndefined(this.stationInfo.enableStatistics) ? this.stationInfo.enableStatistics : true;
  }

  _getNumberOfPhases(): number {
    switch (this._getPowerOutType()) {
      case PowerOutType.AC:
        return !Utils.isUndefined(this.stationInfo.numberOfPhases) ? this.stationInfo.numberOfPhases : 3;
      case PowerOutType.DC:
        return 0;
    }
  }

  _getNumberOfRunningTransactions(): number {
    let trxCount = 0;
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && this.getConnector(Utils.convertToInt(connector)).transactionStarted) {
        trxCount++;
      }
    }
    return trxCount;
  }

  // 0 for disabling
  _getConnectionTimeout(): number {
    if (!Utils.isUndefined(this.stationInfo.connectionTimeout)) {
      return this.stationInfo.connectionTimeout;
    }
    if (!Utils.isUndefined(Configuration.getConnectionTimeout())) {
      return Configuration.getConnectionTimeout();
    }
    return 30;
  }

  // -1 for unlimited, 0 for disabling
  _getAutoReconnectMaxRetries(): number {
    if (!Utils.isUndefined(this.stationInfo.autoReconnectMaxRetries)) {
      return this.stationInfo.autoReconnectMaxRetries;
    }
    if (!Utils.isUndefined(Configuration.getAutoReconnectMaxRetries())) {
      return Configuration.getAutoReconnectMaxRetries();
    }
    return -1;
  }

  // 0 for disabling
  _getRegistrationMaxRetries(): number {
    if (!Utils.isUndefined(this.stationInfo.registrationMaxRetries)) {
      return this.stationInfo.registrationMaxRetries;
    }
    return -1;
  }

  _getPowerDivider(): number {
    let powerDivider = this._getNumberOfConnectors();
    if (this.stationInfo.powerSharedByConnectors) {
      powerDivider = this._getNumberOfRunningTransactions();
    }
    return powerDivider;
  }

  getConnector(id: number): Connector {
    return this.connectors[id];
  }

  _isConnectorAvailable(id: number): boolean {
    return this.getConnector(id).availability === AvailabilityType.OPERATIVE;
  }

  _isChargingStationAvailable(): boolean {
    return this.getConnector(0).availability === AvailabilityType.OPERATIVE;
  }

  _getTemplateMaxNumberOfConnectors(): number {
    return Object.keys(this.stationInfo.Connectors).length;
  }

  _getMaxNumberOfConnectors(): number {
    let maxConnectors = 0;
    if (!Utils.isEmptyArray(this.stationInfo.numberOfConnectors)) {
      const numberOfConnectors = this.stationInfo.numberOfConnectors as number[];
      // Distribute evenly the number of connectors
      maxConnectors = numberOfConnectors[(this.index - 1) % numberOfConnectors.length];
    } else if (!Utils.isUndefined(this.stationInfo.numberOfConnectors)) {
      maxConnectors = this.stationInfo.numberOfConnectors as number;
    } else {
      maxConnectors = this.stationInfo.Connectors[0] ? this._getTemplateMaxNumberOfConnectors() - 1 : this._getTemplateMaxNumberOfConnectors();
    }
    return maxConnectors;
  }

  _getNumberOfConnectors(): number {
    return this.connectors[0] ? Object.keys(this.connectors).length - 1 : Object.keys(this.connectors).length;
  }

  _getVoltageOut(): number {
    const errMsg = `${this._logPrefix()} Unknown ${this._getPowerOutType()} powerOutType in template file ${this.stationTemplateFile}, cannot define default voltage out`;
    let defaultVoltageOut: number;
    switch (this._getPowerOutType()) {
      case PowerOutType.AC:
        defaultVoltageOut = VoltageOut.VOLTAGE_230;
        break;
      case PowerOutType.DC:
        defaultVoltageOut = VoltageOut.VOLTAGE_400;
        break;
      default:
        logger.error(errMsg);
        throw Error(errMsg);
    }
    return !Utils.isUndefined(this.stationInfo.voltageOut) ? this.stationInfo.voltageOut : defaultVoltageOut;
  }

  _getTransactionIdTag(transactionId: number): string {
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && this.getConnector(Utils.convertToInt(connector)).transactionId === transactionId) {
        return this.getConnector(Utils.convertToInt(connector)).idTag;
      }
    }
  }

  _getTransactionMeterStop(transactionId: number): number {
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && this.getConnector(Utils.convertToInt(connector)).transactionId === transactionId) {
        return this.getConnector(Utils.convertToInt(connector)).lastEnergyActiveImportRegisterValue;
      }
    }
  }

  _getPowerOutType(): PowerOutType {
    return !Utils.isUndefined(this.stationInfo.powerOutType) ? this.stationInfo.powerOutType : PowerOutType.AC;
  }

  _getSupervisionURL(): string {
    const supervisionUrls = Utils.cloneObject<string | string[]>(this.stationInfo.supervisionURL ? this.stationInfo.supervisionURL : Configuration.getSupervisionURLs());
    let indexUrl = 0;
    if (!Utils.isEmptyArray(supervisionUrls)) {
      if (Configuration.getDistributeStationsToTenantsEqually()) {
        indexUrl = this.index % supervisionUrls.length;
      } else {
        // Get a random url
        indexUrl = Math.floor(Math.random() * supervisionUrls.length);
      }
      return supervisionUrls[indexUrl];
    }
    return supervisionUrls as string;
  }

  _getReconnectExponentialDelay(): boolean {
    return !Utils.isUndefined(this.stationInfo.reconnectExponentialDelay) ? this.stationInfo.reconnectExponentialDelay : false;
  }

  _getHeartbeatInterval(): number {
    const HeartbeatInterval = this._getConfigurationKey(StandardParametersKey.HeartbeatInterval);
    if (HeartbeatInterval) {
      return Utils.convertToInt(HeartbeatInterval.value) * 1000;
    }
    const HeartBeatInterval = this._getConfigurationKey(StandardParametersKey.HeartBeatInterval);
    if (HeartBeatInterval) {
      return Utils.convertToInt(HeartBeatInterval.value) * 1000;
    }
  }

  _getAuthorizeRemoteTxRequests(): boolean {
    const authorizeRemoteTxRequests = this._getConfigurationKey(StandardParametersKey.AuthorizeRemoteTxRequests);
    return authorizeRemoteTxRequests ? Utils.convertToBoolean(authorizeRemoteTxRequests.value) : false;
  }

  _getLocalAuthListEnabled(): boolean {
    const localAuthListEnabled = this._getConfigurationKey(StandardParametersKey.LocalAuthListEnabled);
    return localAuthListEnabled ? Utils.convertToBoolean(localAuthListEnabled.value) : false;
  }

  async _startMessageSequence(): Promise<void> {
    // Start WebSocket ping
    this._startWebSocketPing();
    // Start heartbeat
    this._startHeartbeat();
    // Initialize connectors status
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) === 0) {
        continue;
      } else if (!this.hasStopped && !this.getConnector(Utils.convertToInt(connector))?.status && this.getConnector(Utils.convertToInt(connector))?.bootStatus) {
        // Send status in template at startup
        await this.sendStatusNotification(Utils.convertToInt(connector), this.getConnector(Utils.convertToInt(connector)).bootStatus);
      } else if (this.hasStopped && this.getConnector(Utils.convertToInt(connector))?.bootStatus) {
        // Send status in template after reset
        await this.sendStatusNotification(Utils.convertToInt(connector), this.getConnector(Utils.convertToInt(connector)).bootStatus);
      } else if (!this.hasStopped && this.getConnector(Utils.convertToInt(connector))?.status) {
        // Send previous status at template reload
        await this.sendStatusNotification(Utils.convertToInt(connector), this.getConnector(Utils.convertToInt(connector)).status);
      } else {
        // Send default status
        await this.sendStatusNotification(Utils.convertToInt(connector), ChargePointStatus.AVAILABLE);
      }
    }
    // Start the ATG
    if (this.stationInfo.AutomaticTransactionGenerator.enable) {
      if (!this.automaticTransactionGeneration) {
        this.automaticTransactionGeneration = new AutomaticTransactionGenerator(this);
      }
      if (this.automaticTransactionGeneration.timeToStop) {
        this.automaticTransactionGeneration.start();
      }
    }
    if (this.getEnableStatistics()) {
      this.statistics.start();
    }
  }

  async _stopMessageSequence(reason: StopTransactionReason = StopTransactionReason.NONE): Promise<void> {
    // Stop WebSocket ping
    this._stopWebSocketPing();
    // Stop heartbeat
    this._stopHeartbeat();
    // Stop the ATG
    if (this.stationInfo.AutomaticTransactionGenerator.enable &&
      this.automaticTransactionGeneration &&
      !this.automaticTransactionGeneration.timeToStop) {
      await this.automaticTransactionGeneration.stop(reason);
    } else {
      for (const connector in this.connectors) {
        if (Utils.convertToInt(connector) > 0 && this.getConnector(Utils.convertToInt(connector)).transactionStarted) {
          await this.sendStopTransaction(this.getConnector(Utils.convertToInt(connector)).transactionId, reason);
        }
      }
    }
  }

  _startWebSocketPing(): void {
    const webSocketPingInterval: number = this._getConfigurationKey(StandardParametersKey.WebSocketPingInterval) ? Utils.convertToInt(this._getConfigurationKey(StandardParametersKey.WebSocketPingInterval).value) : 0;
    if (webSocketPingInterval > 0 && !this.webSocketPingSetInterval) {
      this.webSocketPingSetInterval = setInterval(() => {
        if (this._isWebSocketOpen()) {
          this.wsConnection.ping((): void => { });
        }
      }, webSocketPingInterval * 1000);
      logger.info(this._logPrefix() + ' WebSocket ping started every ' + Utils.secondsToHHMMSS(webSocketPingInterval));
    } else if (this.webSocketPingSetInterval) {
      logger.info(this._logPrefix() + ' WebSocket ping every ' + Utils.secondsToHHMMSS(webSocketPingInterval) + ' already started');
    } else {
      logger.error(`${this._logPrefix()} WebSocket ping interval set to ${webSocketPingInterval ? Utils.secondsToHHMMSS(webSocketPingInterval) : webSocketPingInterval}, not starting the WebSocket ping`);
    }
  }

  _stopWebSocketPing(): void {
    if (this.webSocketPingSetInterval) {
      clearInterval(this.webSocketPingSetInterval);
      this.webSocketPingSetInterval = null;
    }
  }

  _restartWebSocketPing(): void {
    // Stop WebSocket ping
    this._stopWebSocketPing();
    // Start WebSocket ping
    this._startWebSocketPing();
  }

  _startHeartbeat(): void {
    if (this._getHeartbeatInterval() && this._getHeartbeatInterval() > 0 && !this.heartbeatSetInterval) {
      this.heartbeatSetInterval = setInterval(async () => {
        await this.sendHeartbeat();
      }, this._getHeartbeatInterval());
      logger.info(this._logPrefix() + ' Heartbeat started every ' + Utils.milliSecondsToHHMMSS(this._getHeartbeatInterval()));
    } else if (this.heartbeatSetInterval) {
      logger.info(this._logPrefix() + ' Heartbeat every ' + Utils.milliSecondsToHHMMSS(this._getHeartbeatInterval()) + ' already started');
    } else {
      logger.error(`${this._logPrefix()} Heartbeat interval set to ${this._getHeartbeatInterval() ? Utils.milliSecondsToHHMMSS(this._getHeartbeatInterval()) : this._getHeartbeatInterval()}, not starting the heartbeat`);
    }
  }

  _stopHeartbeat(): void {
    if (this.heartbeatSetInterval) {
      clearInterval(this.heartbeatSetInterval);
      this.heartbeatSetInterval = null;
    }
  }

  _restartHeartbeat(): void {
    // Stop heartbeat
    this._stopHeartbeat();
    // Start heartbeat
    this._startHeartbeat();
  }

  _startAuthorizationFileMonitoring(): void {
    fs.watch(this._getAuthorizationFile()).on('change', (e) => {
      try {
        logger.debug(this._logPrefix() + ' Authorization file ' + this._getAuthorizationFile() + ' have changed, reload');
        // Initialize _authorizedTags
        this.authorizedTags = this._getAuthorizedTags();
      } catch (error) {
        logger.error(this._logPrefix() + ' Authorization file monitoring error: %j', error);
      }
    });
  }

  _startStationTemplateFileMonitoring(): void {
    fs.watch(this.stationTemplateFile).on('change', (e) => {
      try {
        logger.debug(this._logPrefix() + ' Template file ' + this.stationTemplateFile + ' have changed, reload');
        // Initialize
        this._initialize();
        // Stop the ATG
        if (!this.stationInfo.AutomaticTransactionGenerator.enable &&
          this.automaticTransactionGeneration) {
          this.automaticTransactionGeneration.stop().catch(() => { });
        }
        // Start the ATG
        if (this.stationInfo.AutomaticTransactionGenerator.enable) {
          if (!this.automaticTransactionGeneration) {
            this.automaticTransactionGeneration = new AutomaticTransactionGenerator(this);
          }
          if (this.automaticTransactionGeneration.timeToStop) {
            this.automaticTransactionGeneration.start();
          }
        }
        // FIXME?: restart heartbeat and WebSocket ping when their interval values have changed
      } catch (error) {
        logger.error(this._logPrefix() + ' Charging station template file monitoring error: %j', error);
      }
    });
  }

  _startMeterValues(connectorId: number, interval: number): void {
    if (connectorId === 0) {
      logger.error(`${this._logPrefix()} Trying to start MeterValues on connector Id ${connectorId.toString()}`);
      return;
    }
    if (!this.getConnector(connectorId)) {
      logger.error(`${this._logPrefix()} Trying to start MeterValues on non existing connector Id ${connectorId.toString()}`);
      return;
    }
    if (!this.getConnector(connectorId)?.transactionStarted) {
      logger.error(`${this._logPrefix()} Trying to start MeterValues on connector Id ${connectorId} with no transaction started`);
      return;
    } else if (this.getConnector(connectorId)?.transactionStarted && !this.getConnector(connectorId)?.transactionId) {
      logger.error(`${this._logPrefix()} Trying to start MeterValues on connector Id ${connectorId} with no transaction id`);
      return;
    }
    if (interval > 0) {
      this.getConnector(connectorId).transactionSetInterval = setInterval(async () => {
        if (this.getEnableStatistics()) {
          const sendMeterValues = performance.timerify(this.sendMeterValues);
          this.performanceObserver.observe({
            entryTypes: ['function'],
          });
          await sendMeterValues(connectorId, interval, this);
        } else {
          await this.sendMeterValues(connectorId, interval, this);
        }
      }, interval);
    } else {
      logger.error(`${this._logPrefix()} Charging station ${StandardParametersKey.MeterValueSampleInterval} configuration set to ${Utils.milliSecondsToHHMMSS(interval)}, not sending MeterValues`);
    }
  }

  _openWSConnection(options?: WebSocket.ClientOptions, forceCloseOpened = false): void {
    if (Utils.isUndefined(options)) {
      options = {} as WebSocket.ClientOptions;
    }
    if (Utils.isUndefined(options.handshakeTimeout)) {
      options.handshakeTimeout = this._getConnectionTimeout() * 1000;
    }
    if (this._isWebSocketOpen() && forceCloseOpened) {
      this.wsConnection.close();
    }
    this.wsConnection = new WebSocket(this.wsConnectionUrl, 'ocpp' + Constants.OCPP_VERSION_16, options);
    logger.info(this._logPrefix() + ' Will communicate through URL ' + this.supervisionUrl);
  }

  start(): void {
    this._openWSConnection();
    // Monitor authorization file
    this._startAuthorizationFileMonitoring();
    // Monitor station template file
    this._startStationTemplateFileMonitoring();
    // Handle Socket incoming messages
    this.wsConnection.on('message', this.onMessage.bind(this));
    // Handle Socket error
    this.wsConnection.on('error', this.onError.bind(this));
    // Handle Socket close
    this.wsConnection.on('close', this.onClose.bind(this));
    // Handle Socket opening connection
    this.wsConnection.on('open', this.onOpen.bind(this));
    // Handle Socket ping
    this.wsConnection.on('ping', this.onPing.bind(this));
    // Handle Socket pong
    this.wsConnection.on('pong', this.onPong.bind(this));
  }

  async stop(reason: StopTransactionReason = StopTransactionReason.NONE): Promise<void> {
    // Stop message sequence
    await this._stopMessageSequence(reason);
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0) {
        await this.sendStatusNotification(Utils.convertToInt(connector), ChargePointStatus.UNAVAILABLE);
      }
    }
    if (this._isWebSocketOpen()) {
      this.wsConnection.close();
    }
    this.bootNotificationResponse = null;
    this.hasStopped = true;
  }

  async _reconnect(error): Promise<void> {
    // Stop heartbeat
    this._stopHeartbeat();
    // Stop the ATG if needed
    if (this.stationInfo.AutomaticTransactionGenerator.enable &&
      this.stationInfo.AutomaticTransactionGenerator.stopOnConnectionFailure &&
      this.automaticTransactionGeneration &&
      !this.automaticTransactionGeneration.timeToStop) {
      this.automaticTransactionGeneration.stop().catch(() => { });
    }
    if (this.autoReconnectRetryCount < this._getAutoReconnectMaxRetries() || this._getAutoReconnectMaxRetries() === -1) {
      this.autoReconnectRetryCount++;
      const reconnectDelay = (this._getReconnectExponentialDelay() ? Utils.exponentialDelay(this.autoReconnectRetryCount) : this._getConnectionTimeout() * 1000);
      logger.error(`${this._logPrefix()} Socket: connection retry in ${Utils.roundTo(reconnectDelay, 2)}ms, timeout ${reconnectDelay - 100}ms`);
      await Utils.sleep(reconnectDelay);
      logger.error(this._logPrefix() + ' Socket: reconnecting try #' + this.autoReconnectRetryCount.toString());
      this._openWSConnection({ handshakeTimeout: reconnectDelay - 100 });
      this.hasSocketRestarted = true;
    } else if (this._getAutoReconnectMaxRetries() !== -1) {
      logger.error(`${this._logPrefix()} Socket reconnect failure: max retries reached (${this.autoReconnectRetryCount}) or retry disabled (${this._getAutoReconnectMaxRetries()})`);
    }
  }

  async onOpen(): Promise<void> {
    logger.info(`${this._logPrefix()} Is connected to server through ${this.wsConnectionUrl}`);
    if (!this._isRegistered()) {
      // Send BootNotification
      let registrationRetryCount = 0;
      do {
        this.bootNotificationResponse = await this.sendBootNotification();
        if (!this._isRegistered()) {
          registrationRetryCount++;
          await Utils.sleep(this.bootNotificationResponse?.interval ? this.bootNotificationResponse.interval * 1000 : Constants.OCPP_DEFAULT_BOOT_NOTIFICATION_INTERVAL);
        }
      } while (!this._isRegistered() && (registrationRetryCount <= this._getRegistrationMaxRetries() || this._getRegistrationMaxRetries() === -1));
    }
    if (this._isRegistered()) {
      await this._startMessageSequence();
      if (this.hasSocketRestarted && this._isWebSocketOpen()) {
        if (!Utils.isEmptyArray(this.messageQueue)) {
          this.messageQueue.forEach((message, index) => {
            this.messageQueue.splice(index, 1);
            this.wsConnection.send(message);
          });
        }
      }
    } else {
      logger.error(`${this._logPrefix()} Registration failure: max retries reached (${this._getRegistrationMaxRetries()}) or retry disabled (${this._getRegistrationMaxRetries()})`);
    }
    this.autoReconnectRetryCount = 0;
    this.hasSocketRestarted = false;
  }

  async onError(errorEvent): Promise<void> {
    logger.error(this._logPrefix() + ' Socket error: %j', errorEvent);
    // pragma switch (errorEvent.code) {
    //   case 'ECONNREFUSED':
    //     await this._reconnect(errorEvent);
    //     break;
    // }
  }

  async onClose(closeEvent): Promise<void> {
    switch (closeEvent) {
      case WebSocketCloseEventStatusCode.CLOSE_NORMAL: // Normal close
      case WebSocketCloseEventStatusCode.CLOSE_NO_STATUS:
        logger.info(`${this._logPrefix()} Socket normally closed with status '${Utils.getWebSocketCloseEventStatusString(closeEvent)}'`);
        this.autoReconnectRetryCount = 0;
        break;
      default: // Abnormal close
        logger.error(`${this._logPrefix()} Socket abnormally closed with status '${Utils.getWebSocketCloseEventStatusString(closeEvent)}'`);
        await this._reconnect(closeEvent);
        break;
    }
  }

  onPing(): void {
    logger.debug(this._logPrefix() + ' Has received a WS ping (rfc6455) from the server');
  }

  onPong(): void {
    logger.debug(this._logPrefix() + ' Has received a WS pong (rfc6455) from the server');
  }

  async onMessage(messageEvent: MessageEvent): Promise<void> {
    let [messageType, messageId, commandName, commandPayload, errorDetails]: IncomingRequest = [0, '', '' as IncomingRequestCommand, {}, {}];
    let responseCallback: (payload?: Record<string, unknown> | string, requestPayload?: Record<string, unknown>) => void;
    let rejectCallback: (error: OCPPError) => void;
    let requestPayload: Record<string, unknown>;
    let errMsg: string;
    try {
      // Parse the message
      [messageType, messageId, commandName, commandPayload, errorDetails] = JSON.parse(messageEvent.toString()) as IncomingRequest;

      // Check the Type of message
      switch (messageType) {
        // Incoming Message
        case MessageType.CALL_MESSAGE:
          if (this.getEnableStatistics()) {
            this.statistics.addMessage(commandName, messageType);
          }
          // Process the call
          await this.handleRequest(messageId, commandName, commandPayload);
          break;
        // Outcome Message
        case MessageType.CALL_RESULT_MESSAGE:
          // Respond
          if (Utils.isIterable(this.requests[messageId])) {
            [responseCallback, , requestPayload] = this.requests[messageId];
          } else {
            throw new Error(`Response request for message id ${messageId} is not iterable`);
          }
          if (!responseCallback) {
            // Error
            throw new Error(`Response request for unknown message id ${messageId}`);
          }
          delete this.requests[messageId];
          responseCallback(commandName, requestPayload);
          break;
        // Error Message
        case MessageType.CALL_ERROR_MESSAGE:
          if (!this.requests[messageId]) {
            // Error
            throw new Error(`Error request for unknown message id ${messageId}`);
          }
          if (Utils.isIterable(this.requests[messageId])) {
            [, rejectCallback] = this.requests[messageId];
          } else {
            throw new Error(`Error request for message id ${messageId} is not iterable`);
          }
          delete this.requests[messageId];
          rejectCallback(new OCPPError(commandName, commandPayload.toString(), errorDetails));
          break;
        // Error
        default:
          errMsg = `${this._logPrefix()} Wrong message type ${messageType}`;
          logger.error(errMsg);
          throw new Error(errMsg);
      }
    } catch (error) {
      // Log
      logger.error('%s Incoming message %j processing error %j on request content type %j', this._logPrefix(), messageEvent, error, this.requests[messageId]);
      // Send error
      messageType !== MessageType.CALL_ERROR_MESSAGE && await this.sendError(messageId, error, commandName);
    }
  }

  async sendHeartbeat(): Promise<void> {
    try {
      const payload: HeartbeatRequest = {};
      await this.sendMessage(Utils.generateUUID(), payload, MessageType.CALL_MESSAGE, RequestCommand.HEARTBEAT);
    } catch (error) {
      this.handleRequestError(RequestCommand.HEARTBEAT, error);
    }
  }

  async sendBootNotification(): Promise<BootNotificationResponse> {
    try {
      return await this.sendMessage(Utils.generateUUID(), this.bootNotificationRequest, MessageType.CALL_MESSAGE, RequestCommand.BOOT_NOTIFICATION) as BootNotificationResponse;
    } catch (error) {
      this.handleRequestError(RequestCommand.BOOT_NOTIFICATION, error);
    }
  }

  async sendStatusNotification(connectorId: number, status: ChargePointStatus, errorCode: ChargePointErrorCode = ChargePointErrorCode.NO_ERROR): Promise<void> {
    this.getConnector(connectorId).status = status;
    try {
      const payload: StatusNotificationRequest = {
        connectorId,
        errorCode,
        status,
      };
      await this.sendMessage(Utils.generateUUID(), payload, MessageType.CALL_MESSAGE, RequestCommand.STATUS_NOTIFICATION);
    } catch (error) {
      this.handleRequestError(RequestCommand.STATUS_NOTIFICATION, error);
    }
  }

  async sendAuthorize(idTag?: string): Promise<AuthorizeResponse> {
    try {
      const payload: AuthorizeRequest = {
        ...!Utils.isUndefined(idTag) ? { idTag } : { idTag: Constants.TRANSACTION_DEFAULT_TAGID },
      };
      return await this.sendMessage(Utils.generateUUID(), payload, MessageType.CALL_MESSAGE, RequestCommand.AUTHORIZE) as AuthorizeResponse;
    } catch (error) {
      this.handleRequestError(RequestCommand.AUTHORIZE, error);
    }
  }

  async sendStartTransaction(connectorId: number, idTag?: string): Promise<StartTransactionResponse> {
    try {
      const payload: StartTransactionRequest = {
        connectorId,
        ...!Utils.isUndefined(idTag) ? { idTag } : { idTag: Constants.TRANSACTION_DEFAULT_TAGID },
        meterStart: 0,
        timestamp: new Date().toISOString(),
      };
      return await this.sendMessage(Utils.generateUUID(), payload, MessageType.CALL_MESSAGE, RequestCommand.START_TRANSACTION) as StartTransactionResponse;
    } catch (error) {
      this.handleRequestError(RequestCommand.START_TRANSACTION, error);
    }
  }

  async sendStopTransaction(transactionId: number, reason: StopTransactionReason = StopTransactionReason.NONE): Promise<StopTransactionResponse> {
    const idTag = this._getTransactionIdTag(transactionId);
    try {
      const payload: StopTransactionRequest = {
        transactionId,
        ...!Utils.isUndefined(idTag) && { idTag: idTag },
        meterStop: this._getTransactionMeterStop(transactionId),
        timestamp: new Date().toISOString(),
        ...reason && { reason },
      };
      return await this.sendMessage(Utils.generateUUID(), payload, MessageType.CALL_MESSAGE, RequestCommand.STOP_TRANSACTION) as StartTransactionResponse;
    } catch (error) {
      this.handleRequestError(RequestCommand.STOP_TRANSACTION, error);
    }
  }

  async sendError(messageId: string, error: OCPPError, commandName: RequestCommand | IncomingRequestCommand): Promise<unknown> {
    // Send error
    return this.sendMessage(messageId, error, MessageType.CALL_ERROR_MESSAGE, commandName);
  }

  async sendMessage(messageId: string, commandParams: any, messageType: MessageType = MessageType.CALL_RESULT_MESSAGE, commandName: RequestCommand | IncomingRequestCommand): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    // Send a message through wsConnection
    return new Promise((resolve: (value?: any | PromiseLike<any>) => void, reject: (reason?: any) => void) => {
      let messageToSend: string;
      // Type of message
      switch (messageType) {
        // Request
        case MessageType.CALL_MESSAGE:
          // Build request
          this.requests[messageId] = [responseCallback, rejectCallback, commandParams] as Request;
          messageToSend = JSON.stringify([messageType, messageId, commandName, commandParams]);
          break;
        // Response
        case MessageType.CALL_RESULT_MESSAGE:
          // Build response
          messageToSend = JSON.stringify([messageType, messageId, commandParams]);
          break;
        // Error Message
        case MessageType.CALL_ERROR_MESSAGE:
          // Build Error Message
          messageToSend = JSON.stringify([messageType, messageId, commandParams.code ? commandParams.code : ErrorType.GENERIC_ERROR, commandParams.message ? commandParams.message : '', commandParams.details ? commandParams.details : {}]);
          break;
      }
      // Check if wsConnection opened and charging station registered
      if (this._isWebSocketOpen() && (this._isRegistered() || commandName === RequestCommand.BOOT_NOTIFICATION)) {
        if (this.getEnableStatistics()) {
          this.statistics.addMessage(commandName, messageType);
        }
        // Yes: Send Message
        this.wsConnection.send(messageToSend);
      } else if (commandName !== RequestCommand.BOOT_NOTIFICATION) {
        let dups = false;
        // Handle dups in buffer
        for (const message of this.messageQueue) {
          // Same message
          if (messageToSend === message) {
            dups = true;
            break;
          }
        }
        if (!dups) {
          // Buffer message
          this.messageQueue.push(messageToSend);
        }
        // Reject it
        return rejectCallback(new OCPPError(commandParams.code ? commandParams.code : ErrorType.GENERIC_ERROR, commandParams.message ? commandParams.message : `WebSocket closed for message id '${messageId}' with content '${messageToSend}', message buffered`, commandParams.details ? commandParams.details : {}));
      }
      // Response?
      if (messageType === MessageType.CALL_RESULT_MESSAGE) {
        // Yes: send Ok
        resolve();
      } else if (messageType === MessageType.CALL_ERROR_MESSAGE) {
        // Send timeout
        setTimeout(() => rejectCallback(new OCPPError(commandParams.code ? commandParams.code : ErrorType.GENERIC_ERROR, commandParams.message ? commandParams.message : `Timeout for message id '${messageId}' with content '${messageToSend}'`, commandParams.details ? commandParams.details : {})), Constants.OCPP_ERROR_TIMEOUT);
      }

      // Function that will receive the request's response
      async function responseCallback(payload: Record<string, unknown> | string, requestPayload: Record<string, unknown>): Promise<void> {
        if (self.getEnableStatistics()) {
          self.statistics.addMessage(commandName, messageType);
        }
        // Send the response
        await self.handleResponse(commandName as RequestCommand, payload, requestPayload);
        resolve(payload);
      }

      // Function that will receive the request's rejection
      function rejectCallback(error: OCPPError): void {
        if (self.getEnableStatistics()) {
          self.statistics.addMessage(commandName, messageType);
        }
        logger.debug(`${self._logPrefix()} Error: %j occurred when calling command %s with parameters: %j`, error, commandName, commandParams);
        // Build Exception
        // eslint-disable-next-line no-empty-function
        self.requests[messageId] = [() => { }, () => { }, {}]; // Properly format the request
        // Send error
        reject(error);
      }
    });
  }

  async handleResponse(commandName: RequestCommand, payload: Record<string, unknown> | string, requestPayload: Record<string, unknown>): Promise<void> {
    const responseCallbackFn = 'handleResponse' + commandName;
    if (typeof this[responseCallbackFn] === 'function') {
      await this[responseCallbackFn](payload, requestPayload);
    } else {
      logger.error(this._logPrefix() + ' Trying to call an undefined response callback function: ' + responseCallbackFn);
    }
  }

  handleResponseBootNotification(payload: BootNotificationResponse, requestPayload: BootNotificationRequest): void {
    if (payload.status === RegistrationStatus.ACCEPTED) {
      this.heartbeatSetInterval ? this._restartHeartbeat() : this._startHeartbeat();
      this._addConfigurationKey(StandardParametersKey.HeartBeatInterval, payload.interval.toString());
      this._addConfigurationKey(StandardParametersKey.HeartbeatInterval, payload.interval.toString(), false, false);
      this.hasStopped && (this.hasStopped = false);
    } else if (payload.status === RegistrationStatus.PENDING) {
      logger.info(this._logPrefix() + ' Charging station in pending state on the central server');
    } else {
      logger.info(this._logPrefix() + ' Charging station rejected by the central server');
    }
  }

  _initTransactionOnConnector(connectorId: number): void {
    this.getConnector(connectorId).transactionStarted = false;
    this.getConnector(connectorId).transactionId = null;
    this.getConnector(connectorId).idTag = null;
    this.getConnector(connectorId).lastEnergyActiveImportRegisterValue = -1;
  }

  _resetTransactionOnConnector(connectorId: number): void {
    this._initTransactionOnConnector(connectorId);
    if (this.getConnector(connectorId)?.transactionSetInterval) {
      clearInterval(this.getConnector(connectorId).transactionSetInterval);
    }
  }

  async handleResponseStartTransaction(payload: StartTransactionResponse, requestPayload: StartTransactionRequest): Promise<void> {
    const connectorId = requestPayload.connectorId;

    let transactionConnectorId: number;
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && Utils.convertToInt(connector) === connectorId) {
        transactionConnectorId = Utils.convertToInt(connector);
        break;
      }
    }
    if (!transactionConnectorId) {
      logger.error(this._logPrefix() + ' Trying to start a transaction on a non existing connector Id ' + connectorId.toString());
      return;
    }
    if (this.getConnector(connectorId)?.transactionStarted) {
      logger.debug(this._logPrefix() + ' Trying to start a transaction on an already used connector ' + connectorId.toString() + ': %j', this.getConnector(connectorId));
      return;
    }

    if (payload?.idTagInfo?.status === AuthorizationStatus.ACCEPTED) {
      this.getConnector(connectorId).transactionStarted = true;
      this.getConnector(connectorId).transactionId = payload.transactionId;
      this.getConnector(connectorId).idTag = requestPayload.idTag;
      this.getConnector(connectorId).lastEnergyActiveImportRegisterValue = 0;
      await this.sendStatusNotification(connectorId, ChargePointStatus.CHARGING);
      logger.info(this._logPrefix() + ' Transaction ' + payload.transactionId.toString() + ' STARTED on ' + this.stationInfo.chargingStationId + '#' + connectorId.toString() + ' for idTag ' + requestPayload.idTag);
      if (this.stationInfo.powerSharedByConnectors) {
        this.stationInfo.powerDivider++;
      }
      const configuredMeterValueSampleInterval = this._getConfigurationKey(StandardParametersKey.MeterValueSampleInterval);
      this._startMeterValues(connectorId,
        configuredMeterValueSampleInterval ? Utils.convertToInt(configuredMeterValueSampleInterval.value) * 1000 : 60000);
    } else {
      logger.error(this._logPrefix() + ' Starting transaction id ' + payload.transactionId.toString() + ' REJECTED with status ' + payload?.idTagInfo?.status + ', idTag ' + requestPayload.idTag);
      this._resetTransactionOnConnector(connectorId);
      await this.sendStatusNotification(connectorId, ChargePointStatus.AVAILABLE);
    }
  }

  async handleResponseStopTransaction(payload: StopTransactionResponse, requestPayload: StopTransactionRequest): Promise<void> {
    let transactionConnectorId: number;
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && this.getConnector(Utils.convertToInt(connector))?.transactionId === requestPayload.transactionId) {
        transactionConnectorId = Utils.convertToInt(connector);
        break;
      }
    }
    if (!transactionConnectorId) {
      logger.error(this._logPrefix() + ' Trying to stop a non existing transaction ' + requestPayload.transactionId.toString());
      return;
    }
    if (payload.idTagInfo?.status === AuthorizationStatus.ACCEPTED) {
      if (!this._isChargingStationAvailable() || !this._isConnectorAvailable(transactionConnectorId)) {
        await this.sendStatusNotification(transactionConnectorId, ChargePointStatus.UNAVAILABLE);
      } else {
        await this.sendStatusNotification(transactionConnectorId, ChargePointStatus.AVAILABLE);
      }
      if (this.stationInfo.powerSharedByConnectors) {
        this.stationInfo.powerDivider--;
      }
      logger.info(this._logPrefix() + ' Transaction ' + requestPayload.transactionId.toString() + ' STOPPED on ' + this.stationInfo.chargingStationId + '#' + transactionConnectorId.toString());
      this._resetTransactionOnConnector(transactionConnectorId);
    } else {
      logger.error(this._logPrefix() + ' Stopping transaction id ' + requestPayload.transactionId.toString() + ' REJECTED with status ' + payload.idTagInfo?.status);
    }
  }

  handleResponseStatusNotification(payload: StatusNotificationRequest, requestPayload: StatusNotificationResponse): void {
    logger.debug(this._logPrefix() + ' Status notification response received: %j to StatusNotification request: %j', payload, requestPayload);
  }

  handleResponseMeterValues(payload: MeterValuesRequest, requestPayload: MeterValuesResponse): void {
    logger.debug(this._logPrefix() + ' MeterValues response received: %j to MeterValues request: %j', payload, requestPayload);
  }

  handleResponseHeartbeat(payload: HeartbeatResponse, requestPayload: HeartbeatRequest): void {
    logger.debug(this._logPrefix() + ' Heartbeat response received: %j to Heartbeat request: %j', payload, requestPayload);
  }

  handleResponseAuthorize(payload: AuthorizeResponse, requestPayload: AuthorizeRequest): void {
    logger.debug(this._logPrefix() + ' Authorize response received: %j to Authorize request: %j', payload, requestPayload);
  }

  async handleRequest(messageId: string, commandName: IncomingRequestCommand, commandPayload: Record<string, unknown>): Promise<void> {
    let response;
    // Call
    if (typeof this['handleRequest' + commandName] === 'function') {
      try {
        // Call the method to build the response
        response = await this['handleRequest' + commandName](commandPayload);
      } catch (error) {
        // Log
        logger.error(this._logPrefix() + ' Handle request error: %j', error);
        // Send back response to inform backend
        await this.sendError(messageId, error, commandName);
        throw error;
      }
    } else {
      // Throw exception
      await this.sendError(messageId, new OCPPError(ErrorType.NOT_IMPLEMENTED, `${commandName} is not implemented`, {}), commandName);
      throw new Error(`${commandName} is not implemented ${JSON.stringify(commandPayload, null, ' ')}`);
    }
    // Send response
    await this.sendMessage(messageId, response, MessageType.CALL_RESULT_MESSAGE, commandName);
  }

  // Simulate charging station restart
  handleRequestReset(commandPayload: ResetRequest): DefaultResponse {
    setImmediate(async () => {
      await this.stop(commandPayload.type + 'Reset' as StopTransactionReason);
      await Utils.sleep(this.stationInfo.resetTime);
      await this.start();
    });
    logger.info(`${this._logPrefix()} ${commandPayload.type} reset command received, simulating it. The station will be back online in ${Utils.milliSecondsToHHMMSS(this.stationInfo.resetTime)}`);
    return Constants.OCPP_RESPONSE_ACCEPTED;
  }

  handleRequestClearCache(): DefaultResponse {
    return Constants.OCPP_RESPONSE_ACCEPTED;
  }

  async handleRequestUnlockConnector(commandPayload: UnlockConnectorRequest): Promise<UnlockConnectorResponse> {
    const connectorId = commandPayload.connectorId;
    if (connectorId === 0) {
      logger.error(this._logPrefix() + ' Trying to unlock connector ' + connectorId.toString());
      return Constants.OCPP_RESPONSE_UNLOCK_NOT_SUPPORTED;
    }
    if (this.getConnector(connectorId)?.transactionStarted) {
      const stopResponse = await this.sendStopTransaction(this.getConnector(connectorId).transactionId, StopTransactionReason.UNLOCK_COMMAND);
      if (stopResponse.idTagInfo?.status === AuthorizationStatus.ACCEPTED) {
        return Constants.OCPP_RESPONSE_UNLOCKED;
      }
      return Constants.OCPP_RESPONSE_UNLOCK_FAILED;
    }
    await this.sendStatusNotification(connectorId, ChargePointStatus.AVAILABLE);
    return Constants.OCPP_RESPONSE_UNLOCKED;
  }

  _getConfigurationKey(key: string | StandardParametersKey, caseInsensitive = false): ConfigurationKey {
    const configurationKey: ConfigurationKey = this.configuration.configurationKey.find((configElement) => {
      if (caseInsensitive) {
        return configElement.key.toLowerCase() === key.toLowerCase();
      }
      return configElement.key === key;
    });
    return configurationKey;
  }

  _addConfigurationKey(key: string | StandardParametersKey, value: string, readonly = false, visible = true, reboot = false): void {
    const keyFound = this._getConfigurationKey(key);
    if (!keyFound) {
      this.configuration.configurationKey.push({
        key,
        readonly,
        value,
        visible,
        reboot,
      });
    } else {
      logger.error(`${this._logPrefix()} Trying to add an already existing configuration key: %j`, keyFound);
    }
  }

  _setConfigurationKeyValue(key: string | StandardParametersKey, value: string): void {
    const keyFound = this._getConfigurationKey(key);
    if (keyFound) {
      const keyIndex = this.configuration.configurationKey.indexOf(keyFound);
      this.configuration.configurationKey[keyIndex].value = value;
    } else {
      logger.error(`${this._logPrefix()} Trying to set a value on a non existing configuration key: %j`, { key, value });
    }
  }

  handleRequestGetConfiguration(commandPayload: GetConfigurationRequest): GetConfigurationResponse {
    const configurationKey: OCPPConfigurationKey[] = [];
    const unknownKey: string[] = [];
    if (Utils.isEmptyArray(commandPayload.key)) {
      for (const configuration of this.configuration.configurationKey) {
        if (Utils.isUndefined(configuration.visible)) {
          configuration.visible = true;
        }
        if (!configuration.visible) {
          continue;
        }
        configurationKey.push({
          key: configuration.key,
          readonly: configuration.readonly,
          value: configuration.value,
        });
      }
    } else {
      for (const key of commandPayload.key) {
        const keyFound = this._getConfigurationKey(key);
        if (keyFound) {
          if (Utils.isUndefined(keyFound.visible)) {
            keyFound.visible = true;
          }
          if (!keyFound.visible) {
            continue;
          }
          configurationKey.push({
            key: keyFound.key,
            readonly: keyFound.readonly,
            value: keyFound.value,
          });
        } else {
          unknownKey.push(key);
        }
      }
    }
    return {
      configurationKey,
      unknownKey,
    };
  }

  handleRequestChangeConfiguration(commandPayload: ChangeConfigurationRequest): ChangeConfigurationResponse {
    // JSON request fields type sanity check
    if (!Utils.isString(commandPayload.key)) {
      logger.error(`${this._logPrefix()} ChangeConfiguration request key field is not a string:`, commandPayload);
    }
    if (!Utils.isString(commandPayload.value)) {
      logger.error(`${this._logPrefix()} ChangeConfiguration request value field is not a string:`, commandPayload);
    }
    const keyToChange = this._getConfigurationKey(commandPayload.key, true);
    if (!keyToChange) {
      return Constants.OCPP_CONFIGURATION_RESPONSE_NOT_SUPPORTED;
    } else if (keyToChange && keyToChange.readonly) {
      return Constants.OCPP_CONFIGURATION_RESPONSE_REJECTED;
    } else if (keyToChange && !keyToChange.readonly) {
      const keyIndex = this.configuration.configurationKey.indexOf(keyToChange);
      let valueChanged = false;
      if (this.configuration.configurationKey[keyIndex].value !== commandPayload.value) {
        this.configuration.configurationKey[keyIndex].value = commandPayload.value;
        valueChanged = true;
      }
      let triggerHeartbeatRestart = false;
      if (keyToChange.key === StandardParametersKey.HeartBeatInterval && valueChanged) {
        this._setConfigurationKeyValue(StandardParametersKey.HeartbeatInterval, commandPayload.value);
        triggerHeartbeatRestart = true;
      }
      if (keyToChange.key === StandardParametersKey.HeartbeatInterval && valueChanged) {
        this._setConfigurationKeyValue(StandardParametersKey.HeartBeatInterval, commandPayload.value);
        triggerHeartbeatRestart = true;
      }
      if (triggerHeartbeatRestart) {
        this._restartHeartbeat();
      }
      if (keyToChange.key === StandardParametersKey.WebSocketPingInterval && valueChanged) {
        this._restartWebSocketPing();
      }
      if (keyToChange.reboot) {
        return Constants.OCPP_CONFIGURATION_RESPONSE_REBOOT_REQUIRED;
      }
      return Constants.OCPP_CONFIGURATION_RESPONSE_ACCEPTED;
    }
  }

  _setChargingProfile(connectorId: number, cp: ChargingProfile): boolean {
    if (!Utils.isEmptyArray(this.getConnector(connectorId).chargingProfiles)) {
      this.getConnector(connectorId).chargingProfiles.forEach((chargingProfile: ChargingProfile, index: number) => {
        if (chargingProfile.chargingProfileId === cp.chargingProfileId
          || (chargingProfile.stackLevel === cp.stackLevel && chargingProfile.chargingProfilePurpose === cp.chargingProfilePurpose)) {
          this.getConnector(connectorId).chargingProfiles[index] = cp;
          return true;
        }
      });
    }
    this.getConnector(connectorId).chargingProfiles.push(cp);
    return true;
  }

  handleRequestSetChargingProfile(commandPayload: SetChargingProfileRequest): SetChargingProfileResponse {
    if (!this.getConnector(commandPayload.connectorId)) {
      logger.error(`${this._logPrefix()} Trying to set a charging profile to a non existing connector Id ${commandPayload.connectorId}`);
      return Constants.OCPP_SET_CHARGING_PROFILE_RESPONSE_REJECTED;
    }
    if (commandPayload.csChargingProfiles.chargingProfilePurpose === ChargingProfilePurposeType.CHARGE_POINT_MAX_PROFILE && commandPayload.connectorId !== 0) {
      return Constants.OCPP_SET_CHARGING_PROFILE_RESPONSE_REJECTED;
    }
    if (commandPayload.csChargingProfiles.chargingProfilePurpose === ChargingProfilePurposeType.TX_PROFILE && (commandPayload.connectorId === 0 || !this.getConnector(commandPayload.connectorId)?.transactionStarted)) {
      return Constants.OCPP_SET_CHARGING_PROFILE_RESPONSE_REJECTED;
    }
    this._setChargingProfile(commandPayload.connectorId, commandPayload.csChargingProfiles);
    return Constants.OCPP_SET_CHARGING_PROFILE_RESPONSE_ACCEPTED;
  }

  handleRequestClearChargingProfile(commandPayload: ClearChargingProfileRequest): ClearChargingProfileResponse {
    if (!this.getConnector(commandPayload.connectorId)) {
      logger.error(`${this._logPrefix()} Trying to clear a charging profile to a non existing connector Id ${commandPayload.connectorId}`);
      return Constants.OCPP_CLEAR_CHARGING_PROFILE_RESPONSE_UNKNOWN;
    }
    if (commandPayload.connectorId && !Utils.isEmptyArray(this.getConnector(commandPayload.connectorId).chargingProfiles)) {
      this.getConnector(commandPayload.connectorId).chargingProfiles = [];
      return Constants.OCPP_CLEAR_CHARGING_PROFILE_RESPONSE_ACCEPTED;
    }
    if (!commandPayload.connectorId) {
      let clearedCP = false;
      for (const connector in this.connectors) {
        if (!Utils.isEmptyArray(this.getConnector(Utils.convertToInt(connector)).chargingProfiles)) {
          this.getConnector(Utils.convertToInt(connector)).chargingProfiles.forEach((chargingProfile: ChargingProfile, index: number) => {
            let clearCurrentCP = false;
            if (chargingProfile.chargingProfileId === commandPayload.id) {
              clearCurrentCP = true;
            }
            if (!commandPayload.chargingProfilePurpose && chargingProfile.stackLevel === commandPayload.stackLevel) {
              clearCurrentCP = true;
            }
            if (!chargingProfile.stackLevel && chargingProfile.chargingProfilePurpose === commandPayload.chargingProfilePurpose) {
              clearCurrentCP = true;
            }
            if (chargingProfile.stackLevel === commandPayload.stackLevel && chargingProfile.chargingProfilePurpose === commandPayload.chargingProfilePurpose) {
              clearCurrentCP = true;
            }
            if (clearCurrentCP) {
              this.getConnector(commandPayload.connectorId).chargingProfiles[index] = {} as ChargingProfile;
              clearedCP = true;
            }
          });
        }
      }
      if (clearedCP) {
        return Constants.OCPP_CLEAR_CHARGING_PROFILE_RESPONSE_ACCEPTED;
      }
    }
    return Constants.OCPP_CLEAR_CHARGING_PROFILE_RESPONSE_UNKNOWN;
  }

  handleRequestChangeAvailability(commandPayload: ChangeAvailabilityRequest): ChangeAvailabilityResponse {
    const connectorId: number = commandPayload.connectorId;
    if (!this.getConnector(connectorId)) {
      logger.error(`${this._logPrefix()} Trying to change the availability of a non existing connector Id ${connectorId.toString()}`);
      return Constants.OCPP_AVAILABILITY_RESPONSE_REJECTED;
    }
    const chargePointStatus: ChargePointStatus = commandPayload.type === AvailabilityType.OPERATIVE ? ChargePointStatus.AVAILABLE : ChargePointStatus.UNAVAILABLE;
    if (connectorId === 0) {
      let response: ChangeAvailabilityResponse = Constants.OCPP_AVAILABILITY_RESPONSE_ACCEPTED;
      for (const connector in this.connectors) {
        if (this.getConnector(Utils.convertToInt(connector)).transactionStarted) {
          response = Constants.OCPP_AVAILABILITY_RESPONSE_SCHEDULED;
        }
        this.getConnector(Utils.convertToInt(connector)).availability = commandPayload.type;
        response === Constants.OCPP_AVAILABILITY_RESPONSE_ACCEPTED && this.sendStatusNotification(Utils.convertToInt(connector), chargePointStatus);
      }
      return response;
    } else if (connectorId > 0 && (this.getConnector(0).availability === AvailabilityType.OPERATIVE || (this.getConnector(0).availability === AvailabilityType.INOPERATIVE && commandPayload.type === AvailabilityType.INOPERATIVE))) {
      if (this.getConnector(connectorId)?.transactionStarted) {
        this.getConnector(connectorId).availability = commandPayload.type;
        return Constants.OCPP_AVAILABILITY_RESPONSE_SCHEDULED;
      }
      this.getConnector(connectorId).availability = commandPayload.type;
      void this.sendStatusNotification(connectorId, chargePointStatus);
      return Constants.OCPP_AVAILABILITY_RESPONSE_ACCEPTED;
    }
    return Constants.OCPP_AVAILABILITY_RESPONSE_REJECTED;
  }

  async handleRequestRemoteStartTransaction(commandPayload: RemoteStartTransactionRequest): Promise<DefaultResponse> {
    const transactionConnectorID: number = commandPayload.connectorId ? commandPayload.connectorId : 1;
    if (this._isChargingStationAvailable() && this._isConnectorAvailable(transactionConnectorID)) {
      if (this._getAuthorizeRemoteTxRequests() && this._getLocalAuthListEnabled() && this.hasAuthorizedTags()) {
        // Check if authorized
        if (this.authorizedTags.find((value) => value === commandPayload.idTag)) {
          await this.sendStatusNotification(transactionConnectorID, ChargePointStatus.PREPARING);
          if (commandPayload.chargingProfile && commandPayload.chargingProfile.chargingProfilePurpose === ChargingProfilePurposeType.TX_PROFILE) {
            this._setChargingProfile(transactionConnectorID, commandPayload.chargingProfile);
          } else if (commandPayload.chargingProfile && commandPayload.chargingProfile.chargingProfilePurpose !== ChargingProfilePurposeType.TX_PROFILE) {
            return Constants.OCPP_RESPONSE_REJECTED;
          }
          // Authorization successful start transaction
          await this.sendStartTransaction(transactionConnectorID, commandPayload.idTag);
          logger.debug(this._logPrefix() + ' Transaction remotely STARTED on ' + this.stationInfo.chargingStationId + '#' + transactionConnectorID.toString() + ' for idTag ' + commandPayload.idTag);
          return Constants.OCPP_RESPONSE_ACCEPTED;
        }
        logger.error(this._logPrefix() + ' Remote starting transaction REJECTED on connector Id ' + transactionConnectorID.toString() + ', idTag ' + commandPayload.idTag);
        return Constants.OCPP_RESPONSE_REJECTED;
      }
      await this.sendStatusNotification(transactionConnectorID, ChargePointStatus.PREPARING);
      if (commandPayload.chargingProfile && commandPayload.chargingProfile.chargingProfilePurpose === ChargingProfilePurposeType.TX_PROFILE) {
        this._setChargingProfile(transactionConnectorID, commandPayload.chargingProfile);
      } else if (commandPayload.chargingProfile && commandPayload.chargingProfile.chargingProfilePurpose !== ChargingProfilePurposeType.TX_PROFILE) {
        return Constants.OCPP_RESPONSE_REJECTED;
      }
      // No local authorization check required => start transaction
      await this.sendStartTransaction(transactionConnectorID, commandPayload.idTag);
      logger.debug(this._logPrefix() + ' Transaction remotely STARTED on ' + this.stationInfo.chargingStationId + '#' + transactionConnectorID.toString() + ' for idTag ' + commandPayload.idTag);
      return Constants.OCPP_RESPONSE_ACCEPTED;
    }
    logger.error(this._logPrefix() + ' Remote starting transaction REJECTED on unavailable connector Id ' + transactionConnectorID.toString() + ', idTag ' + commandPayload.idTag);
    return Constants.OCPP_RESPONSE_REJECTED;
  }

  async handleRequestRemoteStopTransaction(commandPayload: RemoteStopTransactionRequest): Promise<DefaultResponse> {
    const transactionId = commandPayload.transactionId;
    for (const connector in this.connectors) {
      if (Utils.convertToInt(connector) > 0 && this.getConnector(Utils.convertToInt(connector))?.transactionId === transactionId) {
        await this.sendStatusNotification(Utils.convertToInt(connector), ChargePointStatus.FINISHING);
        await this.sendStopTransaction(transactionId);
        return Constants.OCPP_RESPONSE_ACCEPTED;
      }
    }
    logger.info(this._logPrefix() + ' Trying to remote stop a non existing transaction ' + transactionId.toString());
    return Constants.OCPP_RESPONSE_REJECTED;
  }

  // eslint-disable-next-line consistent-this
  private async sendMeterValues(connectorId: number, interval: number, self: ChargingStation, debug = false): Promise<void> {
    try {
      const meterValue: MeterValue = {
        timestamp: new Date().toISOString(),
        sampledValue: [],
      };
      const meterValuesTemplate: SampledValue[] = self.getConnector(connectorId).MeterValues;
      for (let index = 0; index < meterValuesTemplate.length; index++) {
        const connector = self.getConnector(connectorId);
        // SoC measurand
        if (meterValuesTemplate[index].measurand && meterValuesTemplate[index].measurand === MeterValueMeasurand.STATE_OF_CHARGE && self._getConfigurationKey(StandardParametersKey.MeterValuesSampledData).value.includes(MeterValueMeasurand.STATE_OF_CHARGE)) {
          meterValue.sampledValue.push({
            ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.PERCENT },
            ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
            measurand: meterValuesTemplate[index].measurand,
            ...!Utils.isUndefined(meterValuesTemplate[index].location) ? { location: meterValuesTemplate[index].location } : { location: MeterValueLocation.EV },
            ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: Utils.getRandomInt(100).toString() },
          });
          const sampledValuesIndex = meterValue.sampledValue.length - 1;
          if (Utils.convertToInt(meterValue.sampledValue[sampledValuesIndex].value) > 100 || debug) {
            logger.error(`${self._logPrefix()} MeterValues measurand ${meterValue.sampledValue[sampledValuesIndex].measurand ? meterValue.sampledValue[sampledValuesIndex].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: connectorId ${connectorId}, transaction ${connector.transactionId}, value: ${meterValue.sampledValue[sampledValuesIndex].value}/100`);
          }
        // Voltage measurand
        } else if (meterValuesTemplate[index].measurand && meterValuesTemplate[index].measurand === MeterValueMeasurand.VOLTAGE && self._getConfigurationKey(StandardParametersKey.MeterValuesSampledData).value.includes(MeterValueMeasurand.VOLTAGE)) {
          const voltageMeasurandValue = Utils.getRandomFloatRounded(self._getVoltageOut() + self._getVoltageOut() * 0.1, self._getVoltageOut() - self._getVoltageOut() * 0.1);
          meterValue.sampledValue.push({
            ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.VOLT },
            ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
            measurand: meterValuesTemplate[index].measurand,
            ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
            ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: voltageMeasurandValue.toString() },
          });
          for (let phase = 1; self._getNumberOfPhases() === 3 && phase <= self._getNumberOfPhases(); phase++) {
            let phaseValue: string;
            if (self._getVoltageOut() >= 0 && self._getVoltageOut() <= 250) {
              phaseValue = `L${phase}-N`;
            } else if (self._getVoltageOut() > 250) {
              phaseValue = `L${phase}-L${(phase + 1) % self._getNumberOfPhases() !== 0 ? (phase + 1) % self._getNumberOfPhases() : self._getNumberOfPhases()}`;
            }
            meterValue.sampledValue.push({
              ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.VOLT },
              ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
              measurand: meterValuesTemplate[index].measurand,
              ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
              ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: voltageMeasurandValue.toString() },
              phase: phaseValue as MeterValuePhase,
            });
          }
        // Power.Active.Import measurand
        } else if (meterValuesTemplate[index].measurand && meterValuesTemplate[index].measurand === MeterValueMeasurand.POWER_ACTIVE_IMPORT && self._getConfigurationKey(StandardParametersKey.MeterValuesSampledData).value.includes(MeterValueMeasurand.POWER_ACTIVE_IMPORT)) {
          // FIXME: factor out powerDivider checks
          if (Utils.isUndefined(self.stationInfo.powerDivider)) {
            const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: powerDivider is undefined`;
            logger.error(errMsg);
            throw Error(errMsg);
          } else if (self.stationInfo.powerDivider && self.stationInfo.powerDivider <= 0) {
            const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: powerDivider have zero or below value ${self.stationInfo.powerDivider}`;
            logger.error(errMsg);
            throw Error(errMsg);
          }
          const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: Unknown ${self._getPowerOutType()} powerOutType in template file ${self.stationTemplateFile}, cannot calculate ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER} measurand value`;
          const powerMeasurandValues = {} as MeasurandValues;
          const maxPower = Math.round(self.stationInfo.maxPower / self.stationInfo.powerDivider);
          const maxPowerPerPhase = Math.round((self.stationInfo.maxPower / self.stationInfo.powerDivider) / self._getNumberOfPhases());
          switch (self._getPowerOutType()) {
            case PowerOutType.AC:
              if (Utils.isUndefined(meterValuesTemplate[index].value)) {
                powerMeasurandValues.L1 = Utils.getRandomFloatRounded(maxPowerPerPhase);
                powerMeasurandValues.L2 = 0;
                powerMeasurandValues.L3 = 0;
                if (self._getNumberOfPhases() === 3) {
                  powerMeasurandValues.L2 = Utils.getRandomFloatRounded(maxPowerPerPhase);
                  powerMeasurandValues.L3 = Utils.getRandomFloatRounded(maxPowerPerPhase);
                }
                powerMeasurandValues.allPhases = Utils.roundTo(powerMeasurandValues.L1 + powerMeasurandValues.L2 + powerMeasurandValues.L3, 2);
              }
              break;
            case PowerOutType.DC:
              if (Utils.isUndefined(meterValuesTemplate[index].value)) {
                powerMeasurandValues.allPhases = Utils.getRandomFloatRounded(maxPower);
              }
              break;
            default:
              logger.error(errMsg);
              throw Error(errMsg);
          }
          meterValue.sampledValue.push({
            ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.WATT },
            ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
            measurand: meterValuesTemplate[index].measurand,
            ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
            ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: powerMeasurandValues.allPhases.toString() },
          });
          const sampledValuesIndex = meterValue.sampledValue.length - 1;
          if (Utils.convertToFloat(meterValue.sampledValue[sampledValuesIndex].value) > maxPower || debug) {
            logger.error(`${self._logPrefix()} MeterValues measurand ${meterValue.sampledValue[sampledValuesIndex].measurand ? meterValue.sampledValue[sampledValuesIndex].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: connectorId ${connectorId}, transaction ${connector.transactionId}, value: ${meterValue.sampledValue[sampledValuesIndex].value}/${maxPower}`);
          }
          for (let phase = 1; self._getNumberOfPhases() === 3 && phase <= self._getNumberOfPhases(); phase++) {
            const phaseValue = `L${phase}-N`;
            meterValue.sampledValue.push({
              ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.WATT },
              ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
              ...!Utils.isUndefined(meterValuesTemplate[index].measurand) && { measurand: meterValuesTemplate[index].measurand },
              ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
              ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: powerMeasurandValues[`L${phase}`] as string },
              phase: phaseValue as MeterValuePhase,
            });
          }
        // Current.Import measurand
        } else if (meterValuesTemplate[index].measurand && meterValuesTemplate[index].measurand === MeterValueMeasurand.CURRENT_IMPORT && self._getConfigurationKey(StandardParametersKey.MeterValuesSampledData).value.includes(MeterValueMeasurand.CURRENT_IMPORT)) {
          // FIXME: factor out powerDivider checks
          if (Utils.isUndefined(self.stationInfo.powerDivider)) {
            const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: powerDivider is undefined`;
            logger.error(errMsg);
            throw Error(errMsg);
          } else if (self.stationInfo.powerDivider && self.stationInfo.powerDivider <= 0) {
            const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: powerDivider have zero or below value ${self.stationInfo.powerDivider}`;
            logger.error(errMsg);
            throw Error(errMsg);
          }
          const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: Unknown ${self._getPowerOutType()} powerOutType in template file ${self.stationTemplateFile}, cannot calculate ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER} measurand value`;
          const currentMeasurandValues: MeasurandValues = {} as MeasurandValues;
          let maxAmperage: number;
          switch (self._getPowerOutType()) {
            case PowerOutType.AC:
              maxAmperage = ElectricUtils.ampPerPhaseFromPower(self._getNumberOfPhases(), self.stationInfo.maxPower / self.stationInfo.powerDivider, self._getVoltageOut());
              if (Utils.isUndefined(meterValuesTemplate[index].value)) {
                currentMeasurandValues.L1 = Utils.getRandomFloatRounded(maxAmperage);
                currentMeasurandValues.L2 = 0;
                currentMeasurandValues.L3 = 0;
                if (self._getNumberOfPhases() === 3) {
                  currentMeasurandValues.L2 = Utils.getRandomFloatRounded(maxAmperage);
                  currentMeasurandValues.L3 = Utils.getRandomFloatRounded(maxAmperage);
                }
                currentMeasurandValues.allPhases = Utils.roundTo((currentMeasurandValues.L1 + currentMeasurandValues.L2 + currentMeasurandValues.L3) / self._getNumberOfPhases(), 2);
              }
              break;
            case PowerOutType.DC:
              maxAmperage = ElectricUtils.ampTotalFromPower(self.stationInfo.maxPower / self.stationInfo.powerDivider, self._getVoltageOut());
              if (Utils.isUndefined(meterValuesTemplate[index].value)) {
                currentMeasurandValues.allPhases = Utils.getRandomFloatRounded(maxAmperage);
              }
              break;
            default:
              logger.error(errMsg);
              throw Error(errMsg);
          }
          meterValue.sampledValue.push({
            ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.AMP },
            ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
            measurand: meterValuesTemplate[index].measurand,
            ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
            ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: currentMeasurandValues.allPhases.toString() },
          });
          const sampledValuesIndex = meterValue.sampledValue.length - 1;
          if (Utils.convertToFloat(meterValue.sampledValue[sampledValuesIndex].value) > maxAmperage || debug) {
            logger.error(`${self._logPrefix()} MeterValues measurand ${meterValue.sampledValue[sampledValuesIndex].measurand ? meterValue.sampledValue[sampledValuesIndex].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: connectorId ${connectorId}, transaction ${connector.transactionId}, value: ${meterValue.sampledValue[sampledValuesIndex].value}/${maxAmperage}`);
          }
          for (let phase = 1; self._getNumberOfPhases() === 3 && phase <= self._getNumberOfPhases(); phase++) {
            const phaseValue = `L${phase}`;
            meterValue.sampledValue.push({
              ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.AMP },
              ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
              ...!Utils.isUndefined(meterValuesTemplate[index].measurand) && { measurand: meterValuesTemplate[index].measurand },
              ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
              ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } : { value: currentMeasurandValues[phaseValue] as string },
              phase: phaseValue as MeterValuePhase,
            });
          }
        // Energy.Active.Import.Register measurand (default)
        } else if (!meterValuesTemplate[index].measurand || meterValuesTemplate[index].measurand === MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER) {
          // FIXME: factor out powerDivider checks
          if (Utils.isUndefined(self.stationInfo.powerDivider)) {
            const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: powerDivider is undefined`;
            logger.error(errMsg);
            throw Error(errMsg);
          } else if (self.stationInfo.powerDivider && self.stationInfo.powerDivider <= 0) {
            const errMsg = `${self._logPrefix()} MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: powerDivider have zero or below value ${self.stationInfo.powerDivider}`;
            logger.error(errMsg);
            throw Error(errMsg);
          }
          if (Utils.isUndefined(meterValuesTemplate[index].value)) {
            const measurandValue = Utils.getRandomInt(self.stationInfo.maxPower / (self.stationInfo.powerDivider * 3600000) * interval);
            // Persist previous value in connector
            if (connector && !Utils.isNullOrUndefined(connector.lastEnergyActiveImportRegisterValue) && connector.lastEnergyActiveImportRegisterValue >= 0) {
              connector.lastEnergyActiveImportRegisterValue += measurandValue;
            } else {
              connector.lastEnergyActiveImportRegisterValue = 0;
            }
          }
          meterValue.sampledValue.push({
            ...!Utils.isUndefined(meterValuesTemplate[index].unit) ? { unit: meterValuesTemplate[index].unit } : { unit: MeterValueUnit.WATT_HOUR },
            ...!Utils.isUndefined(meterValuesTemplate[index].context) && { context: meterValuesTemplate[index].context },
            ...!Utils.isUndefined(meterValuesTemplate[index].measurand) && { measurand: meterValuesTemplate[index].measurand },
            ...!Utils.isUndefined(meterValuesTemplate[index].location) && { location: meterValuesTemplate[index].location },
            ...!Utils.isUndefined(meterValuesTemplate[index].value) ? { value: meterValuesTemplate[index].value } :
              { value: connector.lastEnergyActiveImportRegisterValue.toString() },
          });
          const sampledValuesIndex = meterValue.sampledValue.length - 1;
          const maxConsumption = Math.round(self.stationInfo.maxPower * 3600 / (self.stationInfo.powerDivider * interval));
          if (Utils.convertToFloat(meterValue.sampledValue[sampledValuesIndex].value) > maxConsumption || debug) {
            logger.error(`${self._logPrefix()} MeterValues measurand ${meterValue.sampledValue[sampledValuesIndex].measurand ? meterValue.sampledValue[sampledValuesIndex].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER}: connectorId ${connectorId}, transaction ${connector.transactionId}, value: ${meterValue.sampledValue[sampledValuesIndex].value}/${maxConsumption}`);
          }
        // Unsupported measurand
        } else {
          logger.info(`${self._logPrefix()} Unsupported MeterValues measurand ${meterValuesTemplate[index].measurand ? meterValuesTemplate[index].measurand : MeterValueMeasurand.ENERGY_ACTIVE_IMPORT_REGISTER} on connectorId ${connectorId}`);
        }
      }
      const payload: MeterValuesRequest = {
        connectorId,
        transactionId: self.getConnector(connectorId).transactionId,
        meterValue: meterValue,
      };
      await self.sendMessage(Utils.generateUUID(), payload, MessageType.CALL_MESSAGE, RequestCommand.METERVALUES);
    } catch (error) {
      this.handleRequestError(RequestCommand.METERVALUES, error);
    }
  }

  private handleRequestError(commandName: RequestCommand, error: Error) {
    logger.error(this._logPrefix() + ' Send ' + commandName + ' error: %j', error);
    throw error;
  }
}


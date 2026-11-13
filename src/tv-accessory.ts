import type { API, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';

import type { DeviceConfig } from './config.js';
import { PowerBusyError, PowerController } from './power-controller.js';
import { PLUGIN_VERSION } from './settings.js';

export class WolTvAccessory {
  readonly controller: PowerController;
  readonly television: Service;

  constructor(
    private readonly api: API,
    readonly accessory: PlatformAccessory,
    private readonly config: DeviceConfig,
    private readonly log: Logging,
  ) {
    const { Service, Characteristic } = api.hap;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'WOL TV')
      .setCharacteristic(Characteristic.Model, 'Wake-on-LAN Host')
      .setCharacteristic(Characteristic.SerialNumber, config.mac.replaceAll(':', ''))
      .setCharacteristic(Characteristic.FirmwareRevision, PLUGIN_VERSION);

    this.television = accessory.getService(Service.Television)
      ?? accessory.addService(Service.Television, config.name, 'television');
    this.television.setPrimaryService(true);
    this.television
      .setCharacteristic(Characteristic.ConfiguredName, config.name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
      .setCharacteristic(Characteristic.ActiveIdentifier, 1);

    this.controller = new PowerController(config, log, (active) => {
      if (active instanceof Error) {
        this.television.updateCharacteristic(
          Characteristic.Active,
          new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        );
      } else {
        this.television.updateCharacteristic(
          Characteristic.Active,
          active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
        );
      }
    });
    this.television.getCharacteristic(Characteristic.Active)
      .onGet(() => {
        try {
          return this.controller.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
        } catch {
          throw new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      })
      .onSet(value => this.setActive(value));

    this.television.getCharacteristic(Characteristic.ActiveIdentifier)
      .onGet(() => 1)
      .onSet((value) => {
        if (value !== 1) {
          throw new api.hap.HapStatusError(api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
      });
    // Television requires RemoteKey; this power-only accessory has no remote transport.
    this.television.getCharacteristic(Characteristic.RemoteKey)
      .onSet(() => { log.debug(`[${config.name}] Remote key ignored; only host power is supported.`); });

    const input = accessory.getServiceById(Service.InputSource, 'host')
      ?? accessory.addService(Service.InputSource, 'Computer', 'host');
    input
      .setCharacteristic(Characteristic.Identifier, 1)
      .setCharacteristic(Characteristic.ConfiguredName, config.name)
      .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
      .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER)
      .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN)
      .setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.TargetVisibilityState.SHOWN);
    this.television.addLinkedService(input);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const { Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    if (value !== Characteristic.Active.ACTIVE && value !== Characteristic.Active.INACTIVE) {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    try {
      await this.controller.setPower(value === Characteristic.Active.ACTIVE);
    } catch (error) {
      this.log.warn(`[${this.config.name}] ${error instanceof Error ? error.message : 'Power command failed.'}`);
      throw new HapStatusError(error instanceof PowerBusyError ? HAPStatus.RESOURCE_BUSY : HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}

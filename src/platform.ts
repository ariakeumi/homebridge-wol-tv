import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { parseDeviceConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { WolTvAccessory } from './tv-accessory.js';

export class WolTvPlatform implements DynamicPlatformPlugin {
  private readonly devices: WolTvAccessory[] = [];

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    api.on('didFinishLaunching', () => this.discoverDevices());
    api.on('shutdown', () => {
      for (const device of this.devices) {
        device.controller.stop();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    // TVs are external accessories, not bridged/cached platform accessories.
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  private discoverDevices(): void {
    if (typeof this.api.isHapEnabled === 'function' && !this.api.isHapEnabled()) {
      this.log.warn('WOL TV requires HAP to be enabled for this bridge.');
      return;
    }
    const configured: unknown = this.config.devices;
    if (configured === undefined || (Array.isArray(configured) && configured.length === 0)) {
      this.log.info('No WOL hosts configured. Add hosts in the WOL TV plugin settings.');
      return;
    }
    if (!Array.isArray(configured)) {
      this.log.error('devices must be an array.');
      return;
    }
    const seen = new Set<string>();
    const api = this.api;
    for (const [index, value] of configured.entries()) {
      try {
        const device = parseDeviceConfig(value);
        if (seen.has(device.mac)) {
          throw new Error(`Duplicate MAC address ${device.mac}. Configure each host only once.`);
        }
        const accessory = new api.platformAccessory(
          device.name,
          api.hap.uuid.generate(`${PLUGIN_NAME}:${device.mac}`),
          api.hap.Categories.TELEVISION,
        );
        const television = new WolTvAccessory(this.api, accessory, device, this.log);
        this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
        seen.add(device.mac);
        this.devices.push(television);
        television.controller.start();
        this.log.info(`[${device.name}] Published TV. Pair it separately in Apple Home using this bridge's pairing code.`);
        if (!device.shutdown) {
          this.log.warn(`[${device.name}] No shutdown action configured; power off is unavailable while the host is online.`);
        }
      } catch (error) {
        this.log.error(`Skipping devices[${index}]: ${error instanceof Error ? error.message : 'Invalid device configuration.'}`);
      }
    }
  }
}

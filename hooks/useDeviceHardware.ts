"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEVICE_HARDWARE_EVENT,
  loadDeviceHardwareSettings,
  resetDeviceHardwareSettings,
  saveDeviceHardwareSettings,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";

export function useDeviceHardware(terminalId?: string | null) {
  const [settings, setSettings] = useState<DeviceHardwareSettings>(() =>
    loadDeviceHardwareSettings(terminalId),
  );

  useEffect(() => {
    const refresh = () => {
      const next = loadDeviceHardwareSettings(terminalId);
      setSettings((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(DEVICE_HARDWARE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DEVICE_HARDWARE_EVENT, refresh);
    };
  }, [terminalId]);

  const updateSettings = useCallback(
    (patch: Partial<DeviceHardwareSettings>) => {
      const next = saveDeviceHardwareSettings(terminalId, {
        ...loadDeviceHardwareSettings(terminalId),
        ...patch,
      });
      setSettings(next);
      return next;
    },
    [terminalId],
  );

  const resetSettings = useCallback(() => {
    const next = resetDeviceHardwareSettings(terminalId);
    setSettings(next);
    return next;
  }, [terminalId]);

  return { settings, updateSettings, resetSettings };
}

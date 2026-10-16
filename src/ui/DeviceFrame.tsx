import type { ReactNode } from 'react';
import { DEVICE_LABEL } from './wall-copy';

// A wall screen in its bezel, shaped like the device class the wall stands in for. The chin says the
// device is simulated, and nothing on it borrows the real device's logo or look.
export function DeviceFrame({ children }: { children?: ReactNode }) {
  return (
    <div className="device">
      <div className="device-screen">{children}</div>
      <p className="device-label">{DEVICE_LABEL}</p>
    </div>
  );
}

export interface AdbDeviceStatus {
  connected: boolean;
  devices: string[];
}

export interface AdbPushResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface NetworkInfo {
  ip: string;
  port: number;
}

export interface StageItineraryResult {
  downloadUrl: string;
  fileName: string;
}

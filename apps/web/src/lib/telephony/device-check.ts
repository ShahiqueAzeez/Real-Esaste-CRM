'use client';

export interface DeviceReport {
  microphone: 'granted' | 'denied' | 'prompt' | 'unavailable';
  inputDeviceLabel: string | null;
  outputDeviceLabel: string | null;
  error?: string;
}

/** Ask for the microphone once, release it immediately, and describe the selected devices. */
export async function checkAudioDevices(): Promise<DeviceReport> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { microphone: 'unavailable', inputDeviceLabel: null, outputDeviceLabel: null, error: 'This browser cannot access a microphone.' };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const track = stream.getAudioTracks()[0];
    const input = track?.label || 'Default microphone';
    stream.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const output = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')?.label || devices.find((d) => d.kind === 'audiooutput')?.label || null;
    return { microphone: 'granted', inputDeviceLabel: input, outputDeviceLabel: output };
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return { microphone: 'denied', inputDeviceLabel: null, outputDeviceLabel: null, error: 'Microphone permission was denied.' };
    if (name === 'NotFoundError') return { microphone: 'unavailable', inputDeviceLabel: null, outputDeviceLabel: null, error: 'No microphone was found.' };
    return { microphone: 'prompt', inputDeviceLabel: null, outputDeviceLabel: null, error: (err as Error).message };
  }
}

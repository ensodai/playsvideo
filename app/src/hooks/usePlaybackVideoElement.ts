import { useLayoutEffect, useState } from 'react';
import type { PlayerControlsType } from '../settings.js';

let videoElementId = 0;

export function usePlaybackVideoElement(controlsType: PlayerControlsType) {
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);

  useLayoutEffect(() => {
    if (!hostElement) {
      setVideoElement(null);
      return;
    }

    const video = document.createElement('video');
    video.id = `pv-${controlsType}-video-${++videoElementId}`;
    video.autoplay = true;
    video.controls = controlsType === 'stock';
    hostElement.replaceChildren(video);
    setVideoElement(video);

    return () => {
      setVideoElement(null);
    };
  }, [controlsType, hostElement]);

  return {
    setVideoHostElement: setHostElement,
    videoElement,
  };
}

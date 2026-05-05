import { useEffect } from 'react';

/**
 * Handles double-click-to-fullscreen and cursor auto-hide in fullscreen.
 * For stock controls: fullscreens the video element (Chrome manages native control auto-hide).
 * For Video.js controls: fullscreens the container so the player chrome stays visible.
 */
export function useFullscreen(
  video: HTMLVideoElement | null,
  container: HTMLElement | null,
) {
  useEffect(() => {
    if (!container) return;
    if (!video) return;

    let cursorTimer: ReturnType<typeof setTimeout>;

    const setCursorHidden = (hidden: boolean) => {
      const value = hidden ? 'none' : '';
      container.style.cursor = value;
      video.style.cursor = value;
    };

    const resetCursorTimer = () => {
      setCursorHidden(false);
      clearTimeout(cursorTimer);
      if (document.fullscreenElement) {
        cursorTimer = setTimeout(() => setCursorHidden(true), 3000);
      }
    };

    const toggleFullscreen = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        // Stock controls: fullscreen the video so Chrome auto-hides native controls.
        // Video.js controls: fullscreen the container so the player chrome stays visible.
        const target = video.controls ? video : container;
        target.requestFullscreen();
      }
    };

    // Video dblclick handler (stock controls path — user clicks directly on video)
    const onVideoDblClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreen();
    };

    // Container dblclick handler (Video.js path or direct container tap target)
    const onContainerDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target !== container &&
        target !== video &&
        !target.classList.contains('pv-tap-target')
      ) {
        return;
      }
      e.preventDefault();
      toggleFullscreen();
    };

    const onFullscreenChange = () => {
      if (document.fullscreenElement) {
        resetCursorTimer();
      } else {
        clearTimeout(cursorTimer);
        setCursorHidden(false);
      }
    };

    const onMouseMove = () => {
      if (document.fullscreenElement) {
        resetCursorTimer();
      }
    };

    video.addEventListener('dblclick', onVideoDblClick);
    container.addEventListener('dblclick', onContainerDblClick);
    container.addEventListener('mousemove', onMouseMove);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => {
      clearTimeout(cursorTimer);
      setCursorHidden(false);
      video.removeEventListener('dblclick', onVideoDblClick);
      container.removeEventListener('dblclick', onContainerDblClick);
      container.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [video, container]);
}

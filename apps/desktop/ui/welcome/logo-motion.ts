// Lifecycle adapter for the reference Foundry OrganicLogo animation.
import {
  blobContour,
  clamp,
  entranceProgress,
  flowPoint,
  inversePoint,
  LOGO_CENTER,
  LOGO_ENTRANCE,
  LOGO_LAUNCH,
  morphContour,
  roundedPath,
  sampleLogoContour,
  stepSpring,
  surfaceLighting,
  transformMatrix,
  transformPoint,
  type Matrix,
  type Point,
  type Spring,
} from './organic-logo.ts';
import { paths } from './logo-data.ts';

export function mountLogoMotion(svg: SVGSVGElement, liftLayer: HTMLSpanElement): () => void {
  let reducedMotion = false;
  interface Petal {
    element: SVGPathElement;
    points: Point[];
    blob: Point[];
    pigment: SVGUseElement;
    light: SVGRadialGradientElement;
    shade: SVGRadialGradientElement;
    progress: number;
  }
  let geometry: Petal[] = [];
  let colourGradients: SVGGradientElement[] = [];
  let prepareFrame = 0;
  let frame = 0,
    previous = 0,
    time = 0,
    entrance = 0,
    rotation = 0;
  let visible = true,
    destroyed = false,
    blobPainted = false;
  let observer: IntersectionObserver | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let liftAnimation: Animation | undefined;
  let media: MediaQueryList | undefined;
  let center = { x: 0, y: 0, size: 66.43 };
  let launchDistance = 90;
  let pointer = { x: -10000, y: -10000, time: 0 };
  let worldPointer: Point = { ...LOGO_CENTER };
  let targetX = 0,
    targetY = 0,
    targetEnergy = 0,
    impulse = 0;
  const springX: Spring = { value: 0, velocity: 0 };
  const springY: Spring = { value: 0, velocity: 0 };
  const energy: Spring = { value: 0, velocity: 0 };
  const squeeze: Spring = { value: 0, velocity: 0 };
  const arrival: Spring = { value: 0.78, velocity: 0 };
  const fixed = (value: number) => value.toFixed(5);

  function measure() {
    // Measure the layout slot, not the sphere's animated translation.
    const rect = svg?.closest('.welcome-icon')?.getBoundingClientRect();
    if (rect) {
      center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, size: rect.width };
      const card = svg
        ?.closest('.composer-area')
        ?.querySelector('.composer')
        ?.getBoundingClientRect();
      // Place the whole ball below the card's top edge; the card occludes it.
      if (card && rect.width)
        launchDistance = (Math.max(0, card.top + 24 - center.y) * 66.43) / rect.width;
    }
    updateTargets();
  }
  function updateTargets() {
    const dx = pointer.x - center.x,
      dy = pointer.y - center.y;
    const distance = Math.hypot(dx, dy);
    const near = clamp(1 - distance / clamp(center.size * 2.7, 150, 240), 0, 1);
    const strength = near * near * (3 - 2 * near);
    targetEnergy = strength;
    targetX = (dx / Math.max(distance, 1)) * strength * 3.2;
    targetY = (dy / Math.max(distance, 1)) * strength * 3.2;
    worldPointer = {
      x: LOGO_CENTER.x + clamp((dx / center.size) * 66.43, -65, 65),
      y: LOGO_CENTER.y + clamp((dy / center.size) * 66.43, -65, 65),
    };
    svg.dataset.motionState = reducedMotion ? 'reduced' : strength > 0.02 ? 'near' : 'idle';
  }
  function onPointerMove(event: PointerEvent) {
    if (event.pointerType === 'touch' || reducedMotion) return;
    const now = performance.now();
    const speed = pointer.time
      ? Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) /
        Math.max(now - pointer.time, 8)
      : 0;
    pointer = { x: event.clientX, y: event.clientY, time: now };
    updateTargets();
    impulse = Math.min(1.4, impulse + Math.min(speed, 3) * targetEnergy * 0.14);
  }
  function release() {
    pointer = { x: -10000, y: -10000, time: 0 };
    updateTargets();
  }

  function render(matrix: Matrix, force: number, still = false) {
    const materialMatrix = `matrix(${matrix.map(fixed).join(' ')})`;
    // Material follows the breathing/stretch; the light stays screen-aligned.
    for (const gradient of colourGradients)
      gradient.setAttribute('gradientTransform', materialMatrix);
    const localPointer = inversePoint(worldPointer, matrix);
    const organicBlend = still ? 0 : entranceProgress(entrance - LOGO_LAUNCH.morphStart, 7);
    for (let index = 0; index < geometry.length; index++) {
      const petal = geometry[index]!;
      const progress = still ? 1 : entranceProgress(entrance - LOGO_LAUNCH.morphStart, index);
      const contour = morphContour(petal.blob, petal.points, progress);
      const world = contour.map((point) => {
        const flowing = flowPoint(point, time, force, localPointer);
        return transformPoint(
          {
            x: point.x + (flowing.x - point.x) * organicBlend,
            y: point.y + (flowing.y - point.y) * organicBlend,
          },
          matrix,
        );
      });
      petal.element.setAttribute('d', roundedPath(world));
      if (progress !== petal.progress) {
        petal.pigment.setAttribute('opacity', fixed(progress));
        petal.progress = progress;
      }
      const light = surfaceLighting(world);
      // These axes stay parallel to the screen as each lobe turns beneath them.
      petal.light.setAttribute(
        'gradientTransform',
        `translate(${fixed(light.highlight.x)} ${fixed(light.highlight.y)}) scale(${fixed(light.rx)} ${fixed(light.ry)})`,
      );
      petal.shade.setAttribute(
        'gradientTransform',
        `translate(${fixed(light.shade.x)} ${fixed(light.shade.y)}) scale(${fixed(light.rx)} ${fixed(light.ry)})`,
      );
    }
    svg?.setAttribute('data-rotation', rotation.toFixed(2));
  }

  function startLift() {
    liftAnimation?.cancel();
    const distance = (launchDistance * center.size) / 66.43;
    // Keep the rise on the compositor; geometry reads this same animation clock.
    const duration = LOGO_LAUNCH.morphStart + LOGO_ENTRANCE.duration;
    liftAnimation = liftLayer.animate(
      [
        {
          transform: `translate3d(0, ${distance}px, 0)`,
          offset: 0,
          easing: 'cubic-bezier(.3333, .6667, .6667, 1)',
        },
        { transform: 'translate3d(0, 0, 0)', offset: LOGO_LAUNCH.duration / duration },
        { transform: 'translate3d(0, 0, 0)', offset: 1 },
      ],
      { duration: duration * 1000, fill: 'both' },
    );
    liftAnimation.pause();
  }

  function tick(now: number) {
    frame = 0;
    if (destroyed || !visible || document.hidden || reducedMotion) return;
    const elapsed = previous ? (now - previous) / 1000 : 1 / 60;
    const dt = Math.min(elapsed, 0.04);
    previous = now;
    entrance = liftAnimation
      ? Number(liftAnimation.currentTime ?? 0) / 1000
      : LOGO_LAUNCH.morphStart + LOGO_ENTRANCE.duration;
    const e = clamp(energy.value, 0, 1.15);
    if (entrance > LOGO_LAUNCH.morphStart) time += dt * (1 + e * 0.5);
    impulse *= Math.exp(-dt * 3.8);
    stepSpring(springX, targetX, dt, 100, 11);
    stepSpring(springY, targetY, dt, 100, 11);
    stepSpring(energy, targetEnergy, dt, 70, 13);
    stepSpring(squeeze, impulse * 0.055 + targetEnergy * 0.025, dt, 145, 9);
    if (entrance > LOGO_LAUNCH.morphStart) stepSpring(arrival, 1, dt, 420, 30);
    const organicBlend = entranceProgress(entrance - LOGO_LAUNCH.morphStart, 7);
    const breathing = Math.sin(time * 1.8) * 0.045 * organicBlend;
    const stretch =
      clamp(squeeze.value + Math.sin(time * 1.8 + Math.PI / 2) * 0.07, -0.12, 0.15) * organicBlend;
    const scale = arrival.value;
    const matrix = transformMatrix(
      rotation,
      scale * (1 + breathing + stretch),
      scale * (1 + breathing - stretch * 0.72),
      springX.value * organicBlend,
      (springY.value + Math.sin(time * 1.8 + 0.2) * 1.6) * organicBlend,
    );
    if (!blobPainted || entrance > LOGO_LAUNCH.morphStart) {
      render(matrix, e + impulse * 0.7);
      blobPainted = true;
    }
    svg.dataset.phase =
      entrance < LOGO_LAUNCH.morphStart + LOGO_ENTRANCE.hold
        ? 'rising'
        : entrance < LOGO_LAUNCH.morphStart + LOGO_ENTRANCE.duration
          ? 'splitting'
          : 'idle';
    frame = requestAnimationFrame(tick);
  }
  function paintStill() {
    rotation = 0;
    svg.dataset.phase = 'idle';
    liftAnimation?.cancel();
    liftAnimation = undefined;
    arrival.value = 1;
    arrival.velocity = 0;
    render(transformMatrix(0), 0, true);
  }
  function syncPlayback() {
    cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    if (reducedMotion) {
      cancelAnimationFrame(prepareFrame);
      prepareFrame = 0;
      release();
      paintStill();
    } else if (visible && !document.hidden && !destroyed) {
      if (prepareFrame) return;
      if (liftAnimation?.playState === 'paused') liftAnimation.play();
      frame = requestAnimationFrame(tick);
    } else liftAnimation?.pause();
  }
  function onPreferenceChange() {
    reducedMotion = media?.matches ?? false;
    updateTargets();
    syncPlayback();
  }
  function replay() {
    if (!geometry.length || destroyed) return;
    cancelAnimationFrame(frame);
    cancelAnimationFrame(prepareFrame);
    frame = 0;
    previous = 0;
    measure();
    entrance = 0;
    rotation = 0;
    time = 0;
    impulse = 0;
    for (const spring of [springX, springY, energy, squeeze]) {
      spring.value = 0;
      spring.velocity = 0;
    }
    arrival.value = 0.78;
    arrival.velocity = 0;
    svg.dataset.phase = 'rising';
    svg.dataset.run = String(Number(svg.dataset.run ?? 0) + 1);
    render(transformMatrix(rotation, 0.78, 0.78), 0);
    startLift();
    blobPainted = true;
    // Commit the reset sphere before replay, so the old flower is never rasterized mid-rise.
    prepareFrame = requestAnimationFrame(() => {
      prepareFrame = requestAnimationFrame(() => {
        prepareFrame = 0;
        syncPlayback();
      });
    });
    if (reducedMotion) syncPlayback();
  }

  {
    geometry = [...svg.querySelectorAll<SVGPathElement>('[data-petal]')].map((element, index) => {
      const points = sampleLogoContour(paths[index]!.d);
      return {
        element,
        points,
        blob: blobContour(points),
        pigment: svg.querySelector<SVGUseElement>(`[data-pigment="${index}"]`)!,
        light: svg.querySelector<SVGRadialGradientElement>(`[data-light="${index}"]`)!,
        shade: svg.querySelector<SVGRadialGradientElement>(`[data-shade="${index}"]`)!,
        progress: -1,
      };
    });
    colourGradients = [...svg.querySelectorAll<SVGGradientElement>('[data-material]')];
    measure();
    media = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = media.matches;
    media.addEventListener('change', onPreferenceChange);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('blur', release);
    window.addEventListener('resize', measure, { passive: true });
    window.addEventListener('scroll', measure, { passive: true, capture: true });
    document.documentElement.addEventListener('pointerleave', release);
    document.addEventListener('visibilitychange', syncPlayback);
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(svg);
    for (const selector of ['main', '.composer-area']) {
      const container = svg.closest(selector);
      if (container) resizeObserver.observe(container);
    }
    observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      syncPlayback();
    });
    observer.observe(svg.closest('.welcome-icon') ?? svg);
    replay();
    svg.classList.add('is-ready');
  }
  const newSession = document.getElementById('new-session');
  newSession?.addEventListener('click', replay);
  return () => {
    destroyed = true;
    cancelAnimationFrame(prepareFrame);
    cancelAnimationFrame(frame);
    liftAnimation?.cancel();
    observer?.disconnect();
    resizeObserver?.disconnect();
    media?.removeEventListener('change', onPreferenceChange);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', release);
    window.removeEventListener('resize', measure);
    window.removeEventListener('scroll', measure, true);
    document.documentElement.removeEventListener('pointerleave', release);
    document.removeEventListener('visibilitychange', syncPlayback);
    newSession?.removeEventListener('click', replay);
  };
}

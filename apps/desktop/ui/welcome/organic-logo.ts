// Geometry and timings ported from the reference Foundry OrganicLogo.
export interface Point {
  x: number;
  y: number;
}
export interface Spring {
  value: number;
  velocity: number;
}
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// The source mark contains absolute M/C/Z contours. Sample their cubic curves
// in memory: repeated SVG getPointAtLength calls block the first visible frame.
export function sampleLogoContour(path: string): Point[] {
  const tokens = path.match(/[a-zA-Z]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/g) ?? [];
  const line: { point: Point; distance: number }[] = [];
  let cursor: Point = { x: 0, y: 0 },
    first = cursor,
    length = 0,
    index = 0;
  const readPoint = (): Point => ({ x: Number(tokens[index++]), y: Number(tokens[index++]) });
  const append = (point: Point) => {
    length += Math.hypot(point.x - cursor.x, point.y - cursor.y);
    line.push({ point, distance: length });
    cursor = point;
  };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') {
      cursor = readPoint();
      first = cursor;
      line.push({ point: cursor, distance: length });
    } else if (command === 'C') {
      const start = cursor,
        a = readPoint(),
        b = readPoint(),
        end = readPoint();
      for (let step = 1; step <= 32; step++) {
        const t = step / 32,
          u = 1 - t;
        append({
          x: u ** 3 * start.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t ** 3 * end.x,
          y: u ** 3 * start.y + 3 * u * u * t * a.y + 3 * u * t * t * b.y + t ** 3 * end.y,
        });
      }
    } else if (command === 'Z') append(first);
    else throw new Error(`Unsupported logo contour command: ${command}`);
  }
  const count = Math.max(24, Math.min(80, Math.ceil(length / 2.4)));
  let segment = 1;
  return Array.from({ length: count }, (_, i) => {
    const distance = (i / count) * length;
    while (segment < line.length - 1 && line[segment]!.distance < distance) segment++;
    const previous = line[segment - 1]!,
      next = line[segment]!;
    const t = (distance - previous.distance) / Math.max(next.distance - previous.distance, 1e-9);
    return {
      x: previous.point.x + (next.point.x - previous.point.x) * t,
      y: previous.point.y + (next.point.y - previous.point.y) * t,
    };
  });
}

// Substep the damped spring so a slow frame cannot fling the material apart.
export function stepSpring(
  spring: Spring,
  target: number,
  dt: number,
  stiffness = 110,
  damping = 13,
) {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const step = Math.min(dt, 0.05) / steps;
  for (let i = 0; i < steps; i++) {
    spring.velocity += ((target - spring.value) * stiffness - spring.velocity * damping) * step;
    spring.value += spring.velocity * step;
  }
}

// A periodic cubic spline rounds the tips of the original Figma contours.
// Every closing segment uses its neighbours, so there is no sharp join at Z.
export function roundedPath(points: Point[]) {
  if (points.length < 4) return '';
  const f = (n: number) => n.toFixed(3);
  let path = `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  for (let i = 0; i < points.length; i++) {
    const a = points[(i - 1 + points.length) % points.length]!;
    const b = points[i]!,
      c = points[(i + 1) % points.length]!,
      d = points[(i + 2) % points.length]!;
    path += `C${f(b.x + (c.x - a.x) / 6)} ${f(b.y + (c.y - a.y) / 6)} ${f(c.x - (d.x - b.x) / 6)} ${f(c.y - (d.y - b.y) / 6)} ${f(c.x)} ${f(c.y)}`;
  }
  return `${path}Z`;
}

// All lobes share this spatial field, including their boundaries. Adjacent
// surfaces therefore bend together instead of opening into sharp seams.
export function flowPoint(point: Point, time: number, energy: number, pointer: Point): Point {
  const dx = point.x - pointer.x,
    dy = point.y - pointer.y;
  const local = Math.exp(-(dx * dx + dy * dy) / 1100) * energy;
  // A slow shared ripple keeps the gel alive without changing its orientation.
  // Sharing the field also keeps adjoining lobe boundaries moving together.
  const idle = 1.1 + Math.sin(time * 1.1) * 0.25;
  const flow = idle * (1 - clamp(energy * 0.4, 0, 0.7)) + local * 1.7;
  return {
    x:
      point.x +
      Math.sin(point.y * 0.15 + time * 1.3 + Math.sin(point.x * 0.09 - time * 0.7)) * flow -
      dy * local * 0.022,
    y:
      point.y +
      Math.cos(point.x * 0.14 - time * 1.1 + Math.cos(point.y * 0.1 + time * 0.6)) * flow +
      dx * local * 0.022,
  };
}

export const LOGO_CENTER = { x: 26.079, y: 27.506 };
export const LOGO_ENTRANCE = { hold: 0, morph: 0.43, stagger: 0.004, duration: 0.5 };
export const LOGO_LAUNCH = { duration: 0.52, morphStart: 0.46 };

// Quadratic ease-out keeps the ascent moving until it reaches its destination.
export function launchOffset(seconds: number, distance: number) {
  return distance * Math.pow(1 - clamp(seconds / LOGO_LAUNCH.duration, 0, 1), 2);
}

export type Matrix = [number, number, number, number, number, number];

export function entranceProgress(seconds: number, petal: number) {
  const t = clamp(
    (seconds - LOGO_ENTRANCE.hold - petal * LOGO_ENTRANCE.stagger) / LOGO_ENTRANCE.morph,
    0,
    1,
  );
  return t * (2 - t);
}

export function blobContour(points: Point[]): Point[] {
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const start = Math.atan2(points[0]!.y - center.y, points[0]!.x - center.x);
  return points.map((_, index) => {
    const angle = start + ((Math.sign(area || 1) * index) / points.length) * Math.PI * 2;
    return { x: LOGO_CENTER.x + Math.cos(angle) * 16, y: LOGO_CENTER.y + Math.sin(angle) * 16 };
  });
}

export function morphContour(blob: Point[], target: Point[], progress: number): Point[] {
  if (progress <= 0) return blob;
  if (progress >= 1) return target;
  return target.map((point, index) => ({
    x: blob[index]!.x + (point.x - blob[index]!.x) * progress,
    y: blob[index]!.y + (point.y - blob[index]!.y) * progress,
  }));
}

export function transformMatrix(angle: number, sx = 1, sy = 1, x = 0, y = 0): Matrix {
  const radians = (angle * Math.PI) / 180,
    c = Math.cos(radians),
    s = Math.sin(radians);
  const a = c * sx,
    b = s * sx,
    d = c * sy,
    c2 = -s * sy;
  return [
    a,
    b,
    c2,
    d,
    LOGO_CENTER.x + x - a * LOGO_CENTER.x - c2 * LOGO_CENTER.y,
    LOGO_CENTER.y + y - b * LOGO_CENTER.x - d * LOGO_CENTER.y,
  ];
}

export function transformPoint(point: Point, [a, b, c, d, e, f]: Matrix): Point {
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function inversePoint(point: Point, [a, b, c, d, e, f]: Matrix): Point {
  const determinant = a * d - b * c;
  return {
    x: (d * (point.x - e) - c * (point.y - f)) / determinant,
    y: (-b * (point.x - e) + a * (point.y - f)) / determinant,
  };
}

// Lighting is calculated AFTER the material has rotated, in viewport-aligned
// SVG coordinates. Its upper-left direction never inherits the material matrix.
export function surfaceLighting(points: Point[]) {
  let left = Infinity,
    right = -Infinity,
    top = Infinity,
    bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const rx = Math.max((right - left) * 0.62, 1),
    ry = Math.max((bottom - top) * 0.62, 1);
  return {
    center,
    rx,
    ry,
    highlight: { x: center.x - rx * 0.34, y: center.y - ry * 0.46 },
    shade: { x: center.x + rx * 0.42, y: center.y + ry * 0.54 },
  };
}

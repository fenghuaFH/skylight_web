// Math utilities for Mobile AR view.
// Translates geographic/ENU coordinates of satellites, stars, and planes
// into screen coordinates based on device orientation sensors.

export interface ARPointOpts {
  alpha: number;             // yaw, degrees (0..360, compass)
  beta: number;              // pitch, degrees (-180..180, tilt)
  gamma: number;             // roll, degrees (-90..90, roll)
  screenAngle: number;       // screen orientation angle, degrees (0, 90, -90, 270)
  screenW: number;           // viewport width in pixels
  screenH: number;           // viewport height in pixels
  hfovDeg: number;           // camera horizontal field of view, degrees
  headingOffsetDeg: number;  // user manual azimuth calibration offset, degrees
}

/**
 * Projects a local ENU vector (east, north, up in meters) to screen coordinates
 * based on the phone's device orientation and screen rotation.
 * Returns screen coordinates {x, y} and depth, or null if the point is behind the camera.
 */
export function projectAR(
  east: number,
  north: number,
  up: number,
  o: ARPointOpts
): { x: number; y: number; zDoc: number } | null {
  // 1. Incorporate heading offset into alpha (yaw).
  const alphaRad = (o.alpha - o.headingOffsetDeg) * Math.PI / 180;
  const betaRad = o.beta * Math.PI / 180;
  const gammaRad = o.gamma * Math.PI / 180;

  // 2. Compute the components of the Ground-to-Device rotation matrix (R^T)
  // where R = R_y(gamma) * R_x(beta) * R_z(alpha)
  const ca = Math.cos(alphaRad);
  const sa = Math.sin(alphaRad);
  const cb = Math.cos(betaRad);
  const sb = Math.sin(betaRad);
  const cg = Math.cos(gammaRad);
  const sg = Math.sin(gammaRad);

  // Row 1 of R^T (Column 1 of R)
  const r11 = cg * ca + sg * sa * sb;
  const r21 = sa * cb;
  const r31 = -sg * ca + cg * sa * sb;

  // Row 2 of R^T (Column 2 of R)
  const r12 = -cg * sa + sg * ca * sb;
  const r22 = ca * cb;
  const r32 = sg * sa + cg * ca * sb;

  // Row 3 of R^T (Column 3 of R)
  const r13 = sg * cb;
  const r23 = -sb;
  const r33 = cg * cb;

  // 3. Rotate the ENU vector to Device Coordinates:
  // xd, yd, zd represent coordinates in the standard device frame (X right, Y up, Z out of screen)
  const xd = r11 * east + r21 * north + r31 * up;
  const yd = r12 * east + r22 * north + r32 * up;
  const zd = r13 * east + r23 * north + r33 * up;

  // 4. Adjust for Screen Orientation Angle (e.g. landscape rotation)
  // If the screen is rotated, we must rotate the (xd, yd) vector around the Z-axis (screen normal).
  let xdScreen = xd;
  let ydScreen = yd;
  if (o.screenAngle !== 0) {
    const rad = -o.screenAngle * Math.PI / 180;
    const cosTh = Math.cos(rad);
    const sinTh = Math.sin(rad);
    xdScreen = xd * cosTh - yd * sinTh;
    ydScreen = xd * sinTh + yd * cosTh;
  }

  // 5. Project onto camera plane.
  // The camera on the back of the phone points in the -Z direction.
  // So objects in front of the camera have depth = -zd.
  const depth = -zd;

  // The object must be in front of the camera and not too close to avoid divide-by-zero
  if (depth <= 0.01) return null;

  // Focal length in pixels based on HFOV
  const hfovRad = o.hfovDeg * Math.PI / 180;
  const f = o.screenW / (2 * Math.tan(hfovRad / 2));

  // Project using standard perspective division
  const x = o.screenW / 2 + xdScreen * (f / depth);
  const y = o.screenH / 2 - ydScreen * (f / depth);

  return { x, y, zDoc: depth };
}

/**
 * Projects a sky coordinate (azimuth, elevation in degrees) to screen coordinates
 * based on device orientation.
 */
export function projectARCelestial(
  azDeg: number,
  elDeg: number,
  o: ARPointOpts
): { x: number; y: number } | null {
  const azRad = azDeg * Math.PI / 180;
  const elRad = elDeg * Math.PI / 180;
  const east = Math.sin(azRad) * Math.cos(elRad);
  const north = Math.cos(azRad) * Math.cos(elRad);
  const up = Math.sin(elRad);

  const projected = projectAR(east, north, up, o);
  if (!projected) return null;
  return { x: projected.x, y: projected.y };
}

/** Full-screen triangle generated from gl_VertexID: no buffers, no attributes. */
export const VERTEX_SHADER = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 0.0, 1.0);
}`;

/*
 * uProj: 0 rectilinear, 1 cylindrical, 2 raw source (letterboxed by viewport).
 * Keep lensRadius() in sync with profileRadius() in lens-model.ts.
 */
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uTex;
uniform int   uProj;
uniform mat3  uRot;        // camera/world ray -> lens ray
uniform vec2  uTanHalf;    // rectilinear: tan(hfov/2), tan(vfov/2)
uniform vec4  uCyl;        // span, azimuth centre, half height, height offset
uniform vec2  uTexSize;
uniform vec2  uCenterPx;
uniform float uRadiusPx;
uniform float uHalfFov;
uniform float uNorm;
uniform int   uProfile;
uniform vec4  uPoly;       // c1..c4
uniform float uPoly5;      // c5

in vec2 vNdc;
out vec4 outColor;

float lensRadius(float t) {
  if (uProfile == 1) return 2.0 * sin(t * 0.5);
  if (uProfile == 2) return 2.0 * tan(t * 0.5);
  if (uProfile == 3) return sin(min(t, 1.57079632679));
  if (uProfile == 4) {
    return t * (uPoly.x + t * (uPoly.y + t * (uPoly.z + t * (uPoly.w + t * uPoly5))));
  }
  return t;
}

void main() {
  if (uProj == 2) {
    outColor = vec4(texture(uTex, vec2(vNdc.x * 0.5 + 0.5, 0.5 - vNdc.y * 0.5)).rgb, 1.0);
    return;
  }

  vec3 ray;
  if (uProj == 0) {
    ray = normalize(vec3(vNdc * uTanHalf, 1.0));
  } else {
    float a = vNdc.x * 0.5 * uCyl.x + uCyl.y;
    ray = normalize(vec3(sin(a), uCyl.w + vNdc.y * uCyl.z, cos(a)));
  }

  vec3 l = uRot * ray;
  float lenXY = length(l.xy);
  float theta = atan(lenXY, l.z);

  // Soft edge at the rim of the image circle.
  float aa = max(fwidth(theta), 1e-4);
  float inside = 1.0 - smoothstep(uHalfFov - aa, uHalfFov + aa, theta);
  if (inside <= 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float r = lensRadius(min(theta, uHalfFov)) / uNorm * uRadiusPx;
  vec2 dir = lenXY > 1e-6 ? l.xy / lenXY : vec2(0.0);
  vec2 p = uCenterPx + vec2(dir.x, -dir.y) * r;
  outColor = vec4(texture(uTex, p / uTexSize).rgb * inside, 1.0);
}`;

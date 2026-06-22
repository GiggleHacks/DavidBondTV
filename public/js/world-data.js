// Country centroids [lat, lng] for the analytics bubble map, plus a flag-emoji
// helper. Covers the most common viewer countries; any country code with data
// but no centroid here is still shown in the ranked list beside the map.
export const CENTROIDS = {
  US: [38, -97], CA: [56, -106], MX: [23, -102], GT: [15, -90], CU: [22, -79], CR: [10, -84],
  BR: [-10, -55], AR: [-34, -64], CO: [4, -73], CL: [-30, -71], PE: [-10, -76], VE: [8, -66],
  EC: [-1, -78], BO: [-17, -64], PY: [-23, -58], UY: [-33, -56],
  GB: [54, -2], IE: [53, -8], FR: [46, 2], ES: [40, -4], PT: [39, -8], DE: [51, 10], IT: [42, 12],
  NL: [52, 5], BE: [50, 4], CH: [47, 8], AT: [47, 14], SE: [62, 15], NO: [62, 10], FI: [64, 26],
  DK: [56, 9], PL: [52, 19], CZ: [49, 15], RO: [46, 25], GR: [39, 22], HU: [47, 19], BG: [43, 25],
  UA: [49, 32], RU: [61, 90], RS: [44, 21], HR: [45, 16],
  TR: [39, 35], SA: [24, 45], AE: [24, 54], IL: [31, 35], IR: [32, 53], IQ: [33, 44], QA: [25, 51],
  IN: [22, 78], PK: [30, 70], BD: [24, 90], LK: [7, 81], NP: [28, 84],
  CN: [35, 103], JP: [36, 138], KR: [36, 128], TW: [24, 121], HK: [22, 114], MO: [22, 113],
  TH: [15, 101], VN: [16, 108], PH: [13, 122], ID: [-2, 118], MY: [4, 102], SG: [1, 104],
  MM: [21, 96], KH: [13, 105], LA: [18, 105], BN: [4, 115],
  AU: [-25, 134], NZ: [-41, 174],
  ZA: [-29, 24], EG: [27, 30], NG: [10, 8], KE: [1, 38], MA: [32, -6], DZ: [28, 3], TN: [34, 9],
  GH: [8, -1], ET: [8, 38], TZ: [-6, 35], UG: [1, 32], AO: [-12, 18], SN: [14, -14],
};

/** ISO-2 country code → flag emoji (regional indicator symbols). */
export function flagEmoji(cc) {
  if (typeof cc !== 'string' || !/^[A-Za-z]{2}$/.test(cc)) return '🏳️';
  const A = 0x1f1e6;
  return String.fromCodePoint(A + cc.toUpperCase().charCodeAt(0) - 65, A + cc.toUpperCase().charCodeAt(1) - 65);
}

/** Equirectangular projection into a 0..360 × 0..180 viewBox. */
export function project(lat, lng) {
  return { x: lng + 180, y: 90 - lat };
}

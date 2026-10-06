// Viridis (perceptually uniform, colour-blind safe), sampled at 11 stops
// from matplotlib's definition and linearly interpolated.
const VIRIDIS = ['#440154', '#482475', '#414487', '#355f8d', '#2a788e', '#21918c', '#22a884', '#44bf70', '#7ad151', '#bddf26', '#fde725'];

export const VIRIDIS_CSS = `linear-gradient(90deg, ${VIRIDIS.join(', ')})`;

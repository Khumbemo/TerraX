/**
 * Space pictures for the app background (public/backgrounds). They are artistic renderings made by
 * scripts/render-backgrounds.py from noise and sphere geometry, not photographs, and are MIT licensed with TerraX.
 */
export const SPACE_IMAGES = [
  ['milky-way', 'Milky Way'],
  ['nebula', 'Nebula'],
  ['spiral-galaxy', 'Spiral galaxy'],
  ['deep-field', 'Deep field'],
  ['starfield', 'Star field'],
  ['moon', 'The Moon'],
  ['mars', 'Mars'],
  ['jupiter', 'Jupiter'],
  ['saturn', 'Saturn'],
  ['neptune', 'Neptune'],
] as const;

export type SpaceImage = (typeof SPACE_IMAGES)[number][0];

export const SPACE_IMAGE_IDS = SPACE_IMAGES.map(([id]) => id) as readonly SpaceImage[];

export const isSpaceImage = (b: string): b is SpaceImage => (SPACE_IMAGE_IDS as readonly string[]).includes(b);

export const spaceImageUrl = (id: SpaceImage, thumb = false) => `./backgrounds/${id}${thumb ? '.thumb' : ''}.webp`;

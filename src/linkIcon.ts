import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faBluesky,
  faGithub,
  faGitlab,
  faInstagram,
  faLinkedin,
  faMastodon,
  faPython,
  faStackOverflow,
  faVimeoV,
  faXTwitter,
  faYoutube,
} from '@fortawesome/free-brands-svg-icons';

// Brand glyphs are passed as definitions; every other id is a solid icon registered
// in main.ts under the same name.
const brands: Record<string, IconDefinition> = {
  bluesky: faBluesky,
  github: faGithub,
  gitlab: faGitlab,
  instagram: faInstagram,
  linkedin: faLinkedin,
  mastodon: faMastodon,
  python: faPython,
  'stack-overflow': faStackOverflow,
  vimeo: faVimeoV,
  'x-twitter': faXTwitter,
  youtube: faYoutube,
};
export const faIcon = (id: string): string | IconDefinition => brands[id] ?? id;

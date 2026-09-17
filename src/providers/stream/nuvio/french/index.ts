/**
 * The French provider group.
 *
 * All 26 sites ported from the gowaru-nuvio-providers repo, in one array so the
 * registry can register the group rather than name each site. Order here is
 * alphabetical by file, not by preference — `registry.ts` decides priority.
 *
 * Two entries look like duplicates and are not: `animevostfr` is animevost-fr.ts
 * (the French mirror of the Russian animevost catalogue) while `animevostfrsite`
 * is animevostfr.ts (the unrelated animevostfr.tv). Both keep the upstream
 * filename for provenance, so only the registry names disambiguate them.
 */

import { animesama } from './anime-sama.js';
import { animeultime } from './anime-ultime.js';
import { animesamaco } from './animesama-co.js';
import { animesultra } from './animesultra.js';
import { animevostfr } from './animevost-fr.js';
import { animevostfrsite } from './animevostfr.js';
import { animoflix } from './animoflix.js';
import { coflix } from './coflix.js';
import { dulourd } from './dulourd.js';
import { flemmix } from './flemmix.js';
import { frenchmanga } from './french-manga.js';
import { frenchstream } from './frenchstream.js';
import { fullanime } from './fullanime.js';
import { movix } from './movix.js';
import { mugiwarastream } from './mugiwarastream.js';
import { nakios } from './nakios.js';
import { nekosama } from './neko-sama.js';
import { papadustream } from './papadustream.js';
import { sekai } from './sekai.js';
import { streamzo } from './streamzo.js';
import { voiranime } from './voiranime.js';
import { voiranimehomes } from './voiranime-homes.js';
import { voiranimerip } from './voiranime-rip.js';
import { vostfree } from './vostfree.js';
import { waveanime } from './waveanime.js';
import { wookafr } from './wookafr.js';

export const FRENCH_PROVIDERS = [
  animesama,
  animesamaco,
  animesultra,
  animeultime,
  animevostfr,
  animevostfrsite,
  animoflix,
  coflix,
  dulourd,
  flemmix,
  frenchmanga,
  frenchstream,
  fullanime,
  movix,
  mugiwarastream,
  nakios,
  nekosama,
  papadustream,
  sekai,
  streamzo,
  voiranime,
  voiranimehomes,
  voiranimerip,
  vostfree,
  waveanime,
  wookafr,
];

export {
  animesama,
  animesamaco,
  animesultra,
  animeultime,
  animevostfr,
  animevostfrsite,
  animoflix,
  coflix,
  dulourd,
  flemmix,
  frenchmanga,
  frenchstream,
  fullanime,
  movix,
  mugiwarastream,
  nakios,
  nekosama,
  papadustream,
  sekai,
  streamzo,
  voiranime,
  voiranimehomes,
  voiranimerip,
  vostfree,
  waveanime,
  wookafr,
};

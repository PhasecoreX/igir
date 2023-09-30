import ProgressBar, { ProgressBarSymbol } from '../console/progressBar.js';
import ArrayPoly from '../polyfill/arrayPoly.js';
import DAT from '../types/dats/dat.js';
import Game from '../types/dats/game.js';
import Header from '../types/dats/logiqx/header.js';
import LogiqxDAT from '../types/dats/logiqx/logiqxDat.js';
import Machine from '../types/dats/mame/machine.js';
import Parent from '../types/dats/parent.js';
import ROM from '../types/dats/rom.js';
import Options, { MergeMode } from '../types/options.js';
import Module from './module.js';

/**
 * Process a {@link DAT} with the ROM merge mode specified.
 *
 * This class may be run concurrently with other classes.
 */
export default class DATMergerSplitter extends Module {
  private readonly options: Options;

  constructor(options: Options, progressBar: ProgressBar) {
    super(progressBar, DATMergerSplitter.name);
    this.options = options;
  }

  /**
   * Un-merge, split, or merge the {@link Game}s within a {@link DAT}.
   */
  async merge(dat: DAT): Promise<DAT> {
    this.progressBar.logInfo(`${dat.getNameShort()}: merging & splitting`);

    // Don't do anything if no type provided
    if (this.options.getMergeRoms() === undefined) {
      this.progressBar.logDebug(`${dat.getNameShort()}: no ROM merge option provided, doing nothing`);
      return dat;
    }

    // Parent/clone information is required to merge & split
    if (!dat.hasParentCloneInfo()) {
      this.progressBar.logDebug(`${dat.getNameShort()}: DAT doesn't have parent/clone info, doing nothing`);
      return dat;
    }

    const gameNamesToGames = dat.getGames().reduce((map, game) => {
      map.set(game.getName(), game);
      return map;
    }, new Map<string, Game>());

    await this.progressBar.setSymbol(ProgressBarSymbol.MERGE_SPLIT);
    await this.progressBar.reset(dat.getGames().length);

    const newGames = dat.getParents()
      .flatMap((parent) => this.mergeParent(parent, gameNamesToGames));
    const newDat = new LogiqxDAT(new Header({
      ...dat.getHeader(),
      romNamesContainDirectories: this.options.getMergeRoms() === MergeMode.MERGED,
    }), newGames);
    this.progressBar.logDebug(`${newDat.getNameShort()}: merged/split to ${newDat.getGames().length.toLocaleString()} game${newDat.getGames().length !== 1 ? 's' : ''}`);

    this.progressBar.logInfo(`${newDat.getNameShort()}: done merging & splitting`);
    return newDat;
  }

  private mergeParent(parent: Parent, gameNamesToGames: Map<string, Game>): Game[] {
    let games = parent.getGames();

    const romNameFunc = (rom: ROM): string => rom.getName()
      // Numeric sort will sort underscore before hyphens? ASCII says don't do that
      .replace('-', '__');
    const romSortFunc = (a: ROM, b: ROM): number => romNameFunc(a)
      .localeCompare(romNameFunc(b), undefined, { numeric: true });

    // Sanitization
    games = games.map((game) => {
      const romNames = game.getRoms().map((rom) => rom.getName());
      return game.withProps({
        rom: game.getRoms()
          // Get rid of duplicate ROMs. MAME will sometimes duplicate a file with the exact same
          // name, size, and checksum but with a different "region" (e.g. neogeo).
          .filter((rom, idx) => romNames.indexOf(rom.getName()) === idx)
          // Sort for easier debugging and testing
          .sort(romSortFunc),
      });
    });

    // 'full' types expect device ROMs to be included
    if (this.options.getMergeRoms() === MergeMode.FULLNONMERGED) {
      games = games.map((game) => {
        if (!(game instanceof Machine)) {
          return game;
        }
        return game.withProps({
          rom: [
            ...game.getDeviceRefs()
              .map((deviceRef) => gameNamesToGames.get(deviceRef.getName()))
              .filter(ArrayPoly.filterNotNullish)
              .flatMap((deviceGame) => deviceGame.getRoms()),
            ...game.getRoms(),
          ].sort(romSortFunc),
        });
      });
    }

    // Non-'full' types expect BIOS files to be in their own set
    if (this.options.getMergeRoms() !== MergeMode.FULLNONMERGED) {
      games = games
        .map((game) => {
          if (!game.getBios()) {
            // This game doesn't use an external BIOS
            return game;
          }

          let biosGame = gameNamesToGames.get(game.getBios());
          if (!biosGame) {
            // Invalid romOf attribute, external BIOS not found
            return game;
          }
          // Only BIOS ROMs in the BIOS parent should be considered. This accounts for clones that
          // reference their non-BIOS parent as their 'romOf'.
          biosGame = biosGame.withProps({
            rom: biosGame.getRoms().filter((rom) => rom.getBios()),
          });

          return game.withProps({
            rom: DATMergerSplitter.diffGameRoms(biosGame, game)
              .sort(romSortFunc),
          });
        });
    }

    // 'split' and 'merged' types should exclude ROMs found in their parent
    if (this.options.getMergeRoms() === MergeMode.SPLIT
      || this.options.getMergeRoms() === MergeMode.MERGED
    ) {
      games = games
        .map((game) => {
          if (!game.getParent()) {
            // This game doesn't have a parent
            return game;
          }

          const parentGame = gameNamesToGames.get(game.getParent());
          if (!parentGame) {
            // Invalid cloneOf attribute, parent not found
            return game;
          }

          return game.withProps({
            rom: DATMergerSplitter.diffGameRoms(parentGame, game)
              .sort(romSortFunc),
          });
        });
    }

    const parentGame = games.find((game) => game.isParent());
    const cloneGames = games
      .filter((game) => game.isClone());

    // For everything other than 'merged' we keep the same number of games
    if (this.options.getMergeRoms() !== MergeMode.MERGED) {
      if (parentGame) {
        return [parentGame, ...cloneGames];
      }
      return cloneGames;
    }

    // For 'merged' we reduce to one game
    const cloneRoms = cloneGames
      .flatMap((game) => game.getRoms()
        .map((rom) => new ROM({
          ...rom,
          name: `${game.getName()}\\${rom.getName()}`,
        })));
    const allRoms = [...cloneRoms, ...(parentGame ? parentGame.getRoms() : [])];
    // And remove any duplicate ROMs, even if the duplicates exist only in clones and not the parent
    const allRomHashCodes = allRoms.map((rom) => rom.hashCode());
    const allRomsDeduplicated = allRoms
      .filter((rom, idx) => allRomHashCodes.indexOf(rom.hashCode()) === idx);
    return [new Machine({
      ...parentGame,
      rom: allRomsDeduplicated,
    })];
  }

  private static diffGameRoms(parent: Game, child: Game): ROM[] {
    const parentRomNamesToHashCodes = parent.getRoms().reduce((map, rom) => {
      map.set(rom.getName(), rom.hashCode());
      return map;
    }, new Map<string, string>());

    return child.getRoms().filter((rom) => {
      const parentName = rom.getMerge() ?? rom.getName();
      const parentHashCode = parentRomNamesToHashCodes.get(parentName);
      if (!parentHashCode) {
        // Parent doesn't have a ROM of the same name -> keep it
        return true;
      }
      if (parentHashCode !== rom.hashCode()) {
        // Parent has a ROM of the same name, but a different checksum -> keep it
        return true;
      }
      return false;
    });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import moment from 'moment';

import ProgressBar, { ProgressBarSymbol } from '../console/progressBar.js';
import Constants from '../constants.js';
import fsPoly from '../polyfill/fsPoly.js';
import DAT from '../types/dats/dat.js';
import Header from '../types/dats/logiqx/header.js';
import LogiqxDAT from '../types/dats/logiqx/logiqxDat.js';
import Parent from '../types/dats/parent.js';
import Options from '../types/options.js';
import OutputFactory from '../types/outputFactory.js';
import ReleaseCandidate from '../types/releaseCandidate.js';
import Module from './module.js';

/**
 * Create a "fixdat" that contains every {@link Game} that has at least one {@link ROM} that wasn't
 * found, and therefore the {@link Game} was not written to the output.
 */
export default class FixdatCreator extends Module {
  private readonly options: Options;

  constructor(options: Options, progressBar: ProgressBar) {
    super(progressBar, FixdatCreator.name);
    this.options = options;
  }

  /**
   * Create & write a fixdat.
   */
  async create(
    originalDat: DAT,
    parentsToCandidates: Map<Parent, ReleaseCandidate[]>,
  ): Promise<string | undefined> {
    if (!this.options.shouldFixdat()) {
      return undefined;
    }

    this.progressBar.logTrace(`${originalDat.getNameShort()}: generating a fixdat`);
    await this.progressBar.setSymbol(ProgressBarSymbol.WRITING);
    await this.progressBar.reset(1);

    // Create an easily searchable index of every ROM that has a ReleaseCandidate
    const writtenRomHashCodes = new Set([...parentsToCandidates.values()]
      .flat()
      .flatMap((releaseCandidate) => releaseCandidate.getRomsWithFiles())
      .map((romWithFiles) => romWithFiles.getRom())
      .map((rom) => rom.hashCode()));
    // Find all the games who have at least one missing ROM
    const gamesWithMissingRoms = originalDat.getGames()
      .filter((game) => !game.getRoms().every((rom) => writtenRomHashCodes.has(rom.hashCode())));
    if (gamesWithMissingRoms.length === 0) {
      this.progressBar.logDebug(`${originalDat.getNameShort()}: not creating a fixdat, all games were found`);
      return undefined;
    }

    const fixdatDir = this.options.shouldWrite()
      ? OutputFactory.getDir(this.options, originalDat)
      : process.cwd();
    if (!await fsPoly.exists(fixdatDir)) {
      await fsPoly.mkdir(fixdatDir, { recursive: true });
    }

    // Construct a new DAT header
    const date = moment().format('YYYYMMDD-HHmmss');
    const header = new Header({
      name: `${originalDat.getHeader().getName()} fixdat`.trim(),
      description: `${originalDat.getHeader().getDescription()} fixdat`.trim(),
      version: date,
      date,
      url: Constants.HOMEPAGE,
      comment: [
        `fixdat generated by ${Constants.COMMAND_NAME} v${Constants.COMMAND_VERSION}`,
        `Original DAT: ${originalDat.toString()}`,
        `Input paths: ${this.options.getInputPaths().map((val) => `'${val}'`).join(', ')}`,
        `Output path: ${fixdatDir}`,
      ].join('\n'),
    });

    // Construct a new DAT and write it to the output dir
    const fixdat = new LogiqxDAT(header, gamesWithMissingRoms);
    const fixdatContents = fixdat.toXmlDat();
    const fixdatPath = path.join(fixdatDir, fixdat.getFilename());
    this.progressBar.logInfo(`${originalDat.getNameShort()}: writing fixdat to '${fixdatPath}'`);
    await util.promisify(fs.writeFile)(fixdatPath, fixdatContents);

    this.progressBar.logTrace(`${originalDat.getNameShort()}: done generating a fixdat`);
    return fixdatPath;
  }
}

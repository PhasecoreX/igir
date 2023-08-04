import fs from 'fs';
import moment from 'moment';
import path from 'path';
import util from 'util';

import ProgressBar, { ProgressBarSymbol } from '../console/progressBar.js';
import Constants from '../constants.js';
import DAT from '../types/logiqx/dat.js';
import Header from '../types/logiqx/header.js';
import Parent from '../types/logiqx/parent.js';
import Options from '../types/options.js';
import ReleaseCandidate from '../types/releaseCandidate.js';
import Module from './module.js';

export default class FixdatCreator extends Module {
  private readonly options: Options;

  constructor(options: Options, progressBar: ProgressBar) {
    super(progressBar, FixdatCreator.name);
    this.options = options;
  }

  async write(
    originalDat: DAT,
    parentsToCandidates: Map<Parent, ReleaseCandidate[]>,
  ): Promise<string | undefined> {
    if (!this.options.getFixdat()) {
      return undefined;
    }

    this.progressBar.logInfo(`${originalDat.getNameShort()}: generating a fixdat`);
    await this.progressBar.setSymbol(ProgressBarSymbol.WRITING);
    await this.progressBar.reset(1);

    // Create an easily searchable index of every ROM that has a ReleaseCandidate
    const writtenRomHashCodes = [...parentsToCandidates.values()]
      .flatMap((releaseCandidates) => releaseCandidates)
      .flatMap((releaseCandidate) => releaseCandidate.getRomsWithFiles())
      .map((romWithFiles) => romWithFiles.getRom())
      .reduce((map, rom) => {
        map.set(rom.hashCode(), true);
        return map;
      }, new Map<string, boolean>());
    // Find all the games who have at least one missing ROM
    const gamesWithMissingRoms = originalDat.getGames()
      .filter((game) => !game.getRoms().every((rom) => writtenRomHashCodes.has(rom.hashCode())));
    if (!gamesWithMissingRoms.length) {
      this.progressBar.logDebug(`${originalDat.getNameShort()}: no missing games`);
      return undefined;
    }

    const fixdatDir = this.options.shouldWrite()
      ? this.options.getOutputDirParsed(originalDat)
      : process.cwd();

    // Construct a new DAT header
    const date = moment().format('YYYYMMDD-HHmmss');
    const header = new Header({
      name: `${originalDat.getHeader().getName()} fixdat`.trim(),
      description: `${originalDat.getHeader().getDescription()} fixdat`.trim(),
      version: date,
      date,
      author: Constants.AUTHOR,
      url: Constants.HOMEPAGE,
      comment: [
        `fixdat generated by ${Constants.COMMAND_NAME} v${Constants.COMMAND_VERSION}`,
        `Original DAT: ${originalDat.toString()}`,
        `Input paths: ${this.options.getInputPaths().map((val) => `'${val}'`).join(', ')}`,
        `Output path: ${fixdatDir}`,
      ].join('\n'),
    });

    // Construct a new DAT and write it to the output dir
    const fixdat = new DAT(header, gamesWithMissingRoms);
    const fixdatContents = fixdat.toXmlDat();
    const fixdatPath = path.join(fixdatDir, fixdat.getFilename());
    await util.promisify(fs.writeFile)(fixdatPath, fixdatContents);

    this.progressBar.logInfo(`${originalDat.getNameShort()}: done generating a fixdat`);

    return fixdatPath;
  }
}

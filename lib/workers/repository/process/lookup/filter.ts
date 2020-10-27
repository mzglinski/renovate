import * as semver from 'semver';
import { CONFIG_VALIDATION } from '../../../../constants/error-messages';
import { Release } from '../../../../datasource';
import { logger } from '../../../../logger';
import { regEx } from '../../../../util/regex';
import * as allVersioning from '../../../../versioning';
import * as npmVersioning from '../../../../versioning/npm';
import * as pep440 from '../../../../versioning/pep440';
import * as poetryVersioning from '../../../../versioning/poetry';

export interface FilterConfig {
  allowedVersions?: string;
  depName?: string;
  followTag?: string;
  ignoreDeprecated?: boolean;
  ignoreUnstable?: boolean;
  respectLatest?: boolean;
  versioning: string;
}

const regexes: Record<string, RegExp> = {};

export function filterVersions(
  config: FilterConfig,
  fromVersion: string,
  latestVersion: string,
  versions: Release[]
): Release[] {
  const {
    ignoreUnstable,
    ignoreDeprecated,
    respectLatest,
    allowedVersions,
  } = config;
  let versioning;
  function isVersionStable(version: string): boolean {
    if (!versioning.isStable(version)) {
      return false;
    }
    return true;
  }
  versioning = allVersioning.get(config.versioning);
  if (!fromVersion) {
    return [];
  }

  // Leave only versions greater than current
  let filteredVersions = versions.filter((v) =>
    versioning.isGreaterThan(v.version, fromVersion)
  );

  // Don't upgrade from non-deprecated to deprecated
  const fromRelease = versions.find(
    (release) => release.version === fromVersion
  );
  if (ignoreDeprecated && fromRelease && !fromRelease.isDeprecated) {
    filteredVersions = filteredVersions.filter((v) => {
      const versionRelease = versions.find(
        (release) => release.version === v.version
      );
      if (versionRelease.isDeprecated) {
        logger.debug(
          `Skipping ${config.depName}@${v.version} because it is deprecated`
        );
        return false;
      }
      return true;
    });
  }

  if (allowedVersions) {
    if (
      allowedVersions.length > 1 &&
      allowedVersions.startsWith('/') &&
      allowedVersions.endsWith('/')
    ) {
      regexes[allowedVersions] =
        regexes[allowedVersions] || regEx(allowedVersions.slice(1, -1));
      filteredVersions = filteredVersions.filter((v) =>
        regexes[allowedVersions].test(v.version)
      );
    } else if (
      allowedVersions.length > 2 &&
      allowedVersions.startsWith('!/') &&
      allowedVersions.endsWith('/')
    ) {
      regexes[allowedVersions] =
        regexes[allowedVersions] || regEx(allowedVersions.slice(2, -1));
      filteredVersions = filteredVersions.filter(
        (v) => !regexes[allowedVersions].test(v.version)
      );
    } else if (versioning.isValid(allowedVersions)) {
      filteredVersions = filteredVersions.filter((v) =>
        versioning.matches(v.version, allowedVersions)
      );
    } else if (
      config.versioning !== npmVersioning.id &&
      semver.validRange(allowedVersions)
    ) {
      logger.debug(
        { depName: config.depName },
        'Falling back to npm semver syntax for allowedVersions'
      );
      filteredVersions = filteredVersions.filter((v) =>
        semver.satisfies(semver.coerce(v.version), allowedVersions)
      );
    } else if (
      config.versioning === poetryVersioning.id &&
      pep440.isValid(allowedVersions)
    ) {
      logger.debug(
        { depName: config.depName },
        'Falling back to pypi syntax for allowedVersions'
      );
      filteredVersions = filteredVersions.filter((v) =>
        pep440.matches(v.version, allowedVersions)
      );
    } else {
      const error = new Error(CONFIG_VALIDATION);
      error.configFile = 'config';
      error.validationError = 'Invalid `allowedVersions`';
      error.validationMessage =
        'The following allowedVersions does not parse as a valid version or range: ' +
        JSON.stringify(allowedVersions);
      throw error;
    }
  }

  // Return all versions if we aren't ignore unstable. Also ignore latest
  if (config.followTag || ignoreUnstable === false) {
    return filteredVersions;
  }

  // if current is unstable then allow unstable in the current major only
  if (!isVersionStable(fromVersion)) {
    // Allow unstable only in current major
    return filteredVersions.filter(
      (v) =>
        isVersionStable(v.version) ||
        (versioning.getMajor(v.version) === versioning.getMajor(fromVersion) &&
          versioning.getMinor(v.version) === versioning.getMinor(fromVersion) &&
          versioning.getPatch(v.version) === versioning.getPatch(fromVersion))
    );
  }

  // Normal case: remove all unstable
  filteredVersions = filteredVersions.filter((v) => isVersionStable(v.version));

  // Filter the latest

  // No filtering if no latest
  // istanbul ignore if
  if (!latestVersion) {
    return filteredVersions;
  }
  // No filtering if not respecting latest
  if (respectLatest === false) {
    return filteredVersions;
  }
  // No filtering if fromVersion is already past latest
  if (versioning.isGreaterThan(fromVersion, latestVersion)) {
    return filteredVersions;
  }
  return filteredVersions.filter(
    (v) => !versioning.isGreaterThan(v.version, latestVersion)
  );
}

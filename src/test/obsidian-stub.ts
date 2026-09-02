export function getAllTags(): string[] {
  return [];
}

export class MetadataCache {}

export const Platform = { isMobileApp: false };

export class Plugin {}

export class TAbstractFile {}

export class TFile extends TAbstractFile {
  basename = "";
  extension = "md";
  path = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class Vault {}

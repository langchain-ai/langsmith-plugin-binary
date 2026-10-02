export function stampsVersion(contents: string, version: string): boolean {
  return contents.includes(`"${version}"`) || contents.includes(`'${version}'`);
}

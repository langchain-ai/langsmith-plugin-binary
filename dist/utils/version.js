export function stampsVersion(contents, version) {
    return contents.includes(`"${version}"`) || contents.includes(`'${version}'`);
}
//# sourceMappingURL=version.js.map
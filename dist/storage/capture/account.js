export function isWaitingForOtherSetting(record, accountFingerprint) {
    return (record.destinationFingerprint !== accountFingerprint &&
        Object.keys(record.delivery?.outcomes ?? {}).length === 0);
}
//# sourceMappingURL=account.js.map
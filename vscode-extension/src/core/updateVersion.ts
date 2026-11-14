/** Compare stable semver versions, returning null for unsupported version strings. */
export function compareStableVersions(left: string, right: string): number | null {
    const parse = (version: string): number[] | null => {
        const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
        return match ? match.slice(1, 4).map(Number) : null;
    };

    const leftParts = parse(left);
    const rightParts = parse(right);
    if (!leftParts || !rightParts) {
        return null;
    }

    for (let index = 0; index < leftParts.length; index++) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] > rightParts[index] ? 1 : -1;
        }
    }
    return 0;
}
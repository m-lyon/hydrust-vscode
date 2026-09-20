export declare const TAG_PATTERN: RegExp;

export declare function platformAssetsFor(tag: string): string[];

export declare function compareTagsDesc(a: string, b: string): number;

export declare function pickPinnableRelease(
    releases: { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string }[] }[]
): string | undefined;

export declare function rewritePin(source: string, tag: string): string;

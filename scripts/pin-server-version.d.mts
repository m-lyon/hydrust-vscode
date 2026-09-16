export declare const PLATFORM_ASSETS: string[];

export declare function pickPinnableRelease(
    releases: { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string }[] }[]
): string | undefined;

export declare function rewritePin(source: string, tag: string): string;

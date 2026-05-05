export namespace config {
	
	export class YTDLPConfig {
	    concurrent_fragments: number;
	    retries: number;
	    fragment_retries: number;
	    container: string;
	    cookies_from_browser: string;
	    continue: boolean;
	    hls_use_mpegts: boolean;
	    safe_mode: boolean;
	
	    static createFrom(source: any = {}) {
	        return new YTDLPConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.concurrent_fragments = source["concurrent_fragments"];
	        this.retries = source["retries"];
	        this.fragment_retries = source["fragment_retries"];
	        this.container = source["container"];
	        this.cookies_from_browser = source["cookies_from_browser"];
	        this.continue = source["continue"];
	        this.hls_use_mpegts = source["hls_use_mpegts"];
	        this.safe_mode = source["safe_mode"];
	    }
	}
	export class DownloadConfig {
	    max_parallel: number;
	    retries: number;
	    retry_delay_sec: number;
	
	    static createFrom(source: any = {}) {
	        return new DownloadConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.max_parallel = source["max_parallel"];
	        this.retries = source["retries"];
	        this.retry_delay_sec = source["retry_delay_sec"];
	    }
	}
	export class PathsConfig {
	    yt_dlp_path: string;
	    ffmpeg_path: string;
	    movies_dir: string;
	    serials_dir: string;
	    log_file: string;
	    links_dir: string;
	
	    static createFrom(source: any = {}) {
	        return new PathsConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.yt_dlp_path = source["yt_dlp_path"];
	        this.ffmpeg_path = source["ffmpeg_path"];
	        this.movies_dir = source["movies_dir"];
	        this.serials_dir = source["serials_dir"];
	        this.log_file = source["log_file"];
	        this.links_dir = source["links_dir"];
	    }
	}
	export class GeneralConfig {
	    version: number;
	    language: string;
	
	    static createFrom(source: any = {}) {
	        return new GeneralConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.language = source["language"];
	    }
	}
	export class Config {
	    general: GeneralConfig;
	    paths: PathsConfig;
	    download: DownloadConfig;
	    yt_dlp: YTDLPConfig;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.general = this.convertValues(source["general"], GeneralConfig);
	        this.paths = this.convertValues(source["paths"], PathsConfig);
	        this.download = this.convertValues(source["download"], DownloadConfig);
	        this.yt_dlp = this.convertValues(source["yt_dlp"], YTDLPConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class Language {
	    code: string;
	    name: string;
	    native_name: string;
	    translations: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new Language(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.code = source["code"];
	        this.name = source["name"];
	        this.native_name = source["native_name"];
	        this.translations = source["translations"];
	    }
	}
	

}

export namespace main {
	
	export class AppInfo {
	    name: string;
	    version: string;
	    author: string;
	
	    static createFrom(source: any = {}) {
	        return new AppInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.version = source["version"];
	        this.author = source["author"];
	    }
	}

}


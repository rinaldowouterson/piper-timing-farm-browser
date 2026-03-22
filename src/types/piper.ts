export interface PhonemizerOutput {
	phoneme_ids: number[];
	phonemes?: string[];
}

export interface PiperPhonemizerModule {
	callMain: (args: string[]) => number;
	print?: (text: string) => void;
	printErr?: (text: string) => void;
	FS: {
		readFile: (path: string, options: { encoding: string }) => string | Uint8Array;
		writeFile: (path: string, data: string | Uint8Array) => void;
		mkdir: (path: string) => void;
	};
}

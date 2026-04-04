/**
 * Piper TTS Model Registry
 *
 * Central registry of all available Piper models with metadata.
 * Used for model selection in UI and provider initialization.
 */

export interface PiperModelDefinition {
	/** Unique identifier (matches model filename without extension) */
	id: string;
	/** Human-readable name */
	name: string;
	/** ISO 639-1 language code */
	language: string;
	/** Country code */
	country: string;
	/** Voice gender or 'multi' for multi-speaker models */
	gender?: "male" | "female" | "multi";
	/** Model quality level */
	quality: "low" | "medium" | "high";
	/** URL to the ONNX model file */
	modelUrl: string;
	/** URL to the model config JSON */
	configUrl: string;
	/** Number of speakers in the model */
	numSpeakers: number;
	/** Whether this is a multi-speaker model */
	isMultiSpeaker: boolean;
	// speakerId for single speaker models
	speakerId: number;
	/** SHA-256 hashes for integrity verification */
	modelSha256?: string;
	configSha256?: string;
}

/**
 * Helper to define a Piper model with derived properties and defaults.
 */
export function definePiperModel(
	model: Omit<PiperModelDefinition, "isMultiSpeaker" | "speakerId"> & { 
		speakerId?: number;
		modelSha256?: string;
		configSha256?: string;
	}
): PiperModelDefinition {
	return {
		...model,
		isMultiSpeaker: model.numSpeakers > 1,
		speakerId: model.speakerId ?? 0,
	};
}

/**
 * Base URL for Piper models in the Hugging Face repository.
 */
export const PIPER_REPO_BASE_URL = "https://huggingface.co/rinaldow/piper-onnx-durations/resolve/main/";

/**
 * All available Piper models.
 * Models are listed in order of recommended default selection.
 */
export const PIPER_MODELS: PiperModelDefinition[] = [
	definePiperModel({
		id: "en_US-bryce-medium",
		name: "Bryce",
		language: "en",
		country: "US",
		gender: "male",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}english/US/male/Bryce/en_US-bryce-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}english/US/male/Bryce/en_US-bryce-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "330c232c12b8a08eb241599190f2ee8ccd6072dce323d10e06684fb0cde8a241",
		configSha256: "7ceb1bc4af6d4e41b6d1edbb86c67e91e01eaa71f66db4cd0ae92ac704d415be",
	}),
	definePiperModel({
		id: "en_US-ljspeech-high",
		name: "Ljspeech",
		language: "en",
		country: "US",
		gender: "female",
		quality: "high",
		modelUrl: `${PIPER_REPO_BASE_URL}english/US/female/Ljspeech/en_US-ljspeech-high.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}english/US/female/Ljspeech/en_US-ljspeech-high.onnx.json`,
		numSpeakers: 1,
		modelSha256: "16e472d4e0b95134c67ebbc7fcb06c92b242adf3ea41f4f2630aaf172349227c",
		configSha256: "7e1f4634af596d83cca997fb7a931ba80b70f8a316a2655ee69c55365e0ace14",
	}),
	definePiperModel({
		id: "en_US-kristin-medium",
		name: "Kristin",
		country: "US",
		language: "en",
		gender: "female",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}english/US/female/Kristin/en_US-kristin-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}english/US/female/Kristin/en_US-kristin-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "f6f2c0e13b186ca0ceae53c4bf0e0dcd4533a8af496c3ee851272275538fb874",
		configSha256: "5681426d4aead22195de70531eeeeddb46493cfaffc5764b2ea3db73428b651c",
	}),
	definePiperModel({
		id: "en_US-arctic-medium",
		name: "Arctic",
		country: "US",
		language: "en",
		gender: "female",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}english/US/female/Arctic/en_US-arctic-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}english/US/female/Arctic/en_US-arctic-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "87057d77bee2a3104a65655adf2d7a1c70ab93b50c8d37c690dbf5660391e4ff",
		configSha256: "db2ca1a55db01cdd3ce28ae63037ac525133e9e00ca557430dec572643235efe",
	}),
	definePiperModel({
		id: "en_GB-cori-medium",
		name: "Cori",
		language: "en",
		country: "GB",
		gender: "female",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}english/UK/female/Cori/en_GB-cori-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}english/UK/female/Cori/en_GB-cori-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "30b6781fbf12ea790f67bb8f2aca550fbc83ab63178d62d181b6aa8369172d29",
		configSha256: "e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36",
	}),
	definePiperModel({
		id: "en_US-libritts-high",
		name: "Libritts",
		language: "en",
		country: "US",
		gender: "multi",
		quality: "high",
		modelUrl: `${PIPER_REPO_BASE_URL}english/US/multi/Libritts/en_US-libritts-high.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}english/US/multi/Libritts/en_US-libritts-high.onnx.json`,
		numSpeakers: 904,
		modelSha256: "5478bb7603d3b7f6e6fc94a3df720647217bc73e4059a6caa7d2bf3f34840376",
		configSha256: "2efdc6d7f954588b8180132cbd9b8001933fdd00932c92bc92fd0d2028a9eb3d",
	}),
	definePiperModel({
		id: "nl_NL-alex-medium",
		name: "Alex",
		language: "nl",
		country: "NL",
		gender: "male",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}dutch/NL/male/Alex/nl_NL-alex-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}dutch/NL/male/Alex/nl_NL-alex-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "a0a8607801723803898cacc2c0708fc9e7a05ee96bcd4fa2a9464a5102bfb79e",
		configSha256: "9ea643871742c038511b6aaf20e6fc098a78a11968122d2f6ca3e50403423f95",
	}),
	definePiperModel({
		id: "nl_BE-rdh-medium",
		name: "Rdh",
		language: "nl",
		country: "BE",
		gender: "male",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}dutch/BE/male/Rdh/nl_BE-rdh-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}dutch/BE/male/Rdh/nl_BE-rdh-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "71fbf84e2601f41727b59032e224f676b2c5bae24ad0b4ae52fdb9267d08c741",
		configSha256: "65deb256664d22099b0db5bb36d96237a3e32e43885c6ce4ee6811e6c04a8d79",
	}),
	definePiperModel({
		id: "sv_SE-alma-medium",
		name: "Alma",
		language: "sv",
		country: "SE",
		gender: "female",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}swedish/female/Alma/sv_SE-alma-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}swedish/female/Alma/sv_SE-alma-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "748ea1721d9399bffdab7120fddc66bf444127d3ac8d79e7d50aa73bc3a6991d",
		configSha256: "6924380892f769afa92fc6b28ff91d558690d7fb4e3ef8cbf821cefadc8f38fe",
	}),
	definePiperModel({
		id: "sv_SE-nst-medium",
		name: "Nst",
		language: "sv",
		country: "SE",
		gender: "male",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}swedish/male/Nst/sv_SE-nst-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}swedish/male/Nst/sv_SE-nst-medium.onnx.json`,
		numSpeakers: 1,
		modelSha256: "99ed2539d568c01598f15d1c175c0795f0cee61588baa77dc663edaab30dd9ce",
		configSha256: "d45dd74cbb4eca58694bf04a97e243044092476f28a55ae26424f0653086980a",
	}),
	definePiperModel({
		id: "uk_UA-ukrainian_tts-medium",
		name: "UkrainianTts",
		language: "uk",
		country: "UA",
		gender: "multi",
		quality: "medium",
		modelUrl: `${PIPER_REPO_BASE_URL}ukrainian/multi/UkrainianTts/uk_UA-ukrainian_tts-medium.onnx`,
		configUrl: `${PIPER_REPO_BASE_URL}ukrainian/multi/UkrainianTts/uk_UA-ukrainian_tts-medium.onnx.json`,
		numSpeakers: 3,
		modelSha256: "3d9412227941720605876329ca2be7b9bcce6d8265779b483d6050b7c497045a",
		configSha256: "4e96e72917ca9b94edc77d6ccfee03a73f450ba2fc1ca93c2e562bc014e5aa55",
	})
];
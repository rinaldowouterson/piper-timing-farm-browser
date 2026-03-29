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
}

/**
 * Helper to define a Piper model with derived properties and defaults.
 */
export function definePiperModel(model: Omit<PiperModelDefinition, "isMultiSpeaker" | "speakerId"> & { speakerId?: number }): PiperModelDefinition {
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
	})
];
import { describe, it, expect } from 'vitest';
import type { PiperModelDefinition } from '../src/types';
import modelsJson from '../src/piper-model-cards.json';

const PIPER_MODELS: PiperModelDefinition[] = modelsJson as PiperModelDefinition[];

describe('piper-model-cards.json Registry Integrity', () => {
    it('should have at least one model registered', () => {
        expect(PIPER_MODELS.length).toBeGreaterThan(0);
    });

    it('should have unique IDs for all models', () => {
        const ids = PIPER_MODELS.map(m => m.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });

    it('should have required fields for every model', () => {
        PIPER_MODELS.forEach(model => {
            expect(model.id, `Model ${model.id} missing id`).toBeTruthy();
            expect(model.name, `Model ${model.id} missing name`).toBeTruthy();
            expect(model.language, `Model ${model.id} missing language`).toBeTruthy();
            expect(model.modelUrl, `Model ${model.id} missing modelUrl`).toBeTruthy();
            expect(model.configUrl, `Model ${model.id} missing configUrl`).toBeTruthy();
            expect(model.numSpeakers, `Model ${model.id} numSpeakers <= 0`).toBeGreaterThan(0);
        });
    });

    it('should have valid URL formats', () => {
        const urlPattern = /^https?:\/\//;
        PIPER_MODELS.forEach(model => {
            expect(model.modelUrl).toMatch(urlPattern);
            expect(model.configUrl).toMatch(urlPattern);
        });
    });

    it('should have integrity hashes (SHA-256) for all models', () => {
        PIPER_MODELS.forEach(model => {
            expect(model.modelSha256, `Model ${model.id} missing modelSha256`).toBeTruthy();
            expect(model.modelSha256).toHaveLength(64);
            expect(model.configSha256, `Model ${model.id} missing configSha256`).toBeTruthy();
            expect(model.configSha256).toHaveLength(64);
        });
    });

    it('should correctly derive isMultiSpeaker', () => {
        PIPER_MODELS.forEach(model => {
            if (model.numSpeakers > 1) {
                expect(model.isMultiSpeaker).toBe(true);
            } else {
                expect(model.isMultiSpeaker).toBe(false);
            }
        });
    });
});

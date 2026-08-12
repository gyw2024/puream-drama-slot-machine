"use strict";

function normalizeCachedPureamAuthorization(value) {
  const code = String(value || "").replace(/[\s-]+/g, "").trim().toUpperCase();
  return /^[A-Z0-9]{12,64}$/.test(code) ? code : "";
}

function findStoredPureamAuthorization(settings = {}) {
  const candidates = [
    settings.textProviderProfiles?.["puream-relay"]?.apiKey,
    settings.textProvider?.kind === "puream-relay" ? settings.textProvider.apiKey : "",
    settings.imageProvider?.apiKey,
    settings.digitalHumanProvider?.apiKey,
    settings.videoProvider?.apiKey
  ];
  return candidates.map(normalizeCachedPureamAuthorization).find(Boolean) || "";
}

async function ensurePureamLicenseSession(licenseClient, settings = {}) {
  const initial = licenseClient.getSnapshot();
  const recoveredCode = licenseClient.storedActivationCode() || findStoredPureamAuthorization(settings);
  if (!initial.activated) {
    if (!recoveredCode) return { snapshot: initial, recovered: false };
    return { snapshot: await licenseClient.login(recoveredCode), recovered: true };
  }
  try {
    return { snapshot: await licenseClient.ensureSession(), recovered: false };
  } catch (error) {
    const recoverable = ["SESSION_EXPIRED", "UNAUTHORIZED", "NEED_ACTIVATION", "INVALID_CODE"]
      .includes(String(error?.code || ""));
    if (!recoverable || !recoveredCode) throw error;
    return { snapshot: await licenseClient.login(recoveredCode), recovered: true };
  }
}

function hydratePureamDefaults(store, activationCode = "", options = {}) {
  const settings = store.getSettings();
  const pureamTextCredential = settings.textProviderProfiles?.["puream-relay"]?.apiKey
    || (settings.textProvider?.kind === "puream-relay" ? settings.textProvider.apiKey : "")
    || "";
  const credential = String(
    activationCode
    || settings.imageProvider?.apiKey
    || settings.digitalHumanProvider?.apiKey
    || pureamTextCredential
    || ""
  ).trim().toUpperCase();
  if (!credential) return { configured: false, source: "missing", settings };

  settings.textProviderProfiles = {
    ...(settings.textProviderProfiles || {}),
    "puream-relay": {
      ...(settings.textProviderProfiles?.["puream-relay"] || {}),
      kind: "puream-relay",
      apiKey: credential
    }
  };
  if (settings.textProvider?.kind === "puream-relay") {
    settings.textProvider = { ...settings.textProvider, apiKey: credential };
  }
  settings.imageProvider = { ...settings.imageProvider, apiKey: credential };
  settings.digitalHumanProvider = { ...settings.digitalHumanProvider, apiKey: credential };
  // Keep any user OSS fields as fallback. Managed hosting is preferred, but wiping
  // OSS previously forced every project onto a missing /api/desktop/media/upload.
  settings.videoProvider = {
    ...settings.videoProvider,
    apiKey: credential,
    storageMode: "managed",
    managedStorageBaseUrl: "https://puream.cn"
  };
  const saved = store.saveSettings(settings);
  options.bridge?.configure?.(saved.videoProvider);
  return {
    configured: true,
    source: activationCode ? "license-activation" : "workbench-safe-storage",
    settings: saved
  };
}

module.exports = { hydratePureamDefaults, findStoredPureamAuthorization, ensurePureamLicenseSession };

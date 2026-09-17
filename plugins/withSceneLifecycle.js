const { IOSConfig, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Adopts the UIKit scene-based life cycle on iOS.
 *
 * Apps built against the iOS 27 SDK (Xcode 27) assert at launch unless they adopt it:
 * "Application failed to launch: UIScene life cycle is required for apps built with this SDK."
 *
 * The Expo SDK 57 prebuild template still generates the legacy app-delegate life cycle, so this
 * plugin backports what the SDK 58 template does — `expo` 57 already ships the native
 * `ExpoAppSceneDelegate` and `ExpoReactNativeFactoryProvider` this relies on. It can be dropped
 * once the project moves to SDK 58.
 *
 * The scene manifest itself lives in `app.json` under `ios.infoPlist.UIApplicationSceneManifest`.
 */

const SCENE_DELEGATE_FILENAME = 'SceneDelegate.swift';

const SCENE_DELEGATE_CONTENTS = `internal import Expo

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`;

// The window is created by the scene delegate now, so the app delegate must stop creating one.
const LEGACY_WINDOW_SETUP =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;

function patchAppDelegate(contents) {
  let next = contents;

  if (!next.includes('ExpoReactNativeFactoryProvider')) {
    const declaration = 'class AppDelegate: ExpoAppDelegate {';
    if (!next.includes(declaration)) {
      throw new Error(
        `withSceneLifecycle: could not find "${declaration}" in AppDelegate.swift. The template ` +
          'probably changed — check whether this plugin is still needed.'
      );
    }
    next = next.replace(
      declaration,
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
    );
  }

  if (LEGACY_WINDOW_SETUP.test(next)) {
    next = next.replace(
      LEGACY_WINDOW_SETUP,
      '\n    // The window is created and React Native is started by `SceneDelegate` under the\n' +
        '    // scene-based life cycle (required by the iOS 27 SDK).\n'
    );
  } else if (next.includes('factory.startReactNative(')) {
    throw new Error(
      'withSceneLifecycle: AppDelegate.swift still starts React Native itself, but its window ' +
        'setup did not match the expected shape. Starting React Native twice renders a blank ' +
        'screen, so remove that block by hand or update this plugin.'
    );
  }

  return next;
}

/** Writes SceneDelegate.swift and strips the legacy window setup out of AppDelegate.swift. */
const withSceneDelegateFiles = (config) =>
  withDangerousMod(config, [
    'ios',
    (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;
      const sourceDir = path.join(projectRoot, config.modRequest.projectName);

      fs.writeFileSync(path.join(sourceDir, SCENE_DELEGATE_FILENAME), SCENE_DELEGATE_CONTENTS);

      const appDelegatePath = path.join(sourceDir, 'AppDelegate.swift');
      const appDelegate = fs.readFileSync(appDelegatePath, 'utf8');
      const patched = patchAppDelegate(appDelegate);
      if (patched !== appDelegate) {
        fs.writeFileSync(appDelegatePath, patched);
      }

      return config;
    },
  ]);

/** Adds SceneDelegate.swift to the app target so it actually gets compiled. */
const withSceneDelegateInXcodeProject = (config) =>
  withXcodeProject(config, (config) => {
    const project = config.modResults;
    const groupName = config.modRequest.projectName;
    const filePath = `${groupName}/${SCENE_DELEGATE_FILENAME}`;

    if (!project.hasFile(filePath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: filePath,
        groupName,
        project,
      });
    }

    return config;
  });

module.exports = function withSceneLifecycle(config) {
  return withSceneDelegateInXcodeProject(withSceneDelegateFiles(config));
};

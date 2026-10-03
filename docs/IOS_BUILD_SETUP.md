# Cosme's Mac: Sauti iOS build preparation

Carter asked Platform to help Cosme prepare Xcode and offered his Apple Developer membership for signing. This guide is preparation, not a claim that Xcode, signing or a phone build has passed. Mobile remains the owner of `apps/mobile`; Cosme prepares the Mac and coordinates device builds/profiling with Mobile and Max.

Room decision `47482` keeps EAS on Carter's PC as the primary build path. The Mac supplies a local native build/debugging and Instruments path. Carter can choose the Mac as the primary path once it is ready.

## 1. Inventory the Mac and start the full Xcode download

Confirm that the available Apple computer is a Mac. In Terminal, collect these non-secret checks:

```sh
sw_vers
uname -m
sysctl -n hw.model
sysctl -n hw.memsize
df -h /
```

Install the newest stable Xcode compatible with both that macOS version and the target iPhone's iOS. Use the [Mac App Store Xcode listing](https://apps.apple.com/app/xcode/id497799835), or [Apple's downloads](https://developer.apple.com/download/all/) when a compatible earlier release is required. Match against [Apple's Xcode requirements table](https://developer.apple.com/xcode/system-requirements/) before a large download or OS upgrade. Command Line Tools alone do not provide this native app build environment.

Open Xcode once, complete its first-launch setup, and install the iOS platform components. In Xcode Settings, select the full Xcode toolchain under Locations and an appropriate iOS Simulator runtime under Components/Platforms. Apple's current guide is [installing Xcode components](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

For a standard `/Applications/Xcode.app` installation, run:

```sh
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
xcode-select -p
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
xcrun simctl list devices available
```

If the app is installed elsewhere, substitute its actual path. The selected developer directory should point inside the full Xcode app.

## 2. Prepare React Native dependencies

Follow the project's committed Node/package-manager/Ruby pins as Mobile and Platform publish them. Current desktop core checks use Node 22. Do not generate a second lockfile or upgrade another lane's dependencies on the Mac.

If Homebrew is already installed, a practical preparation is:

```sh
brew install node@22 watchman
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
npm --version
watchman --version
ruby --version
bundle --version
```

If Homebrew is absent, use its [official installation instructions](https://brew.sh/). CocoaPods needs a compatible Ruby/Bundler setup. Use the mobile project's `Gemfile` and lockfile once supplied: run `bundle install` in the directory containing that Gemfile, then `bundle exec pod install` in its `ios` directory. Do not use `sudo gem install` as a blanket fix. [React Native's environment guide](https://reactnative.dev/docs/set-up-your-environment) documents the Xcode, Watchman and CocoaPods prerequisites.

Mobile supplies the exact branch/commit, dependency install command, Expo prebuild command if applicable, model hash and resulting `.xcworkspace`. Until those exist, toolchain setup can finish but an app build is pending. If native files are generated from Expo, preserve Mobile's config plugins and committed dependency pins.

## 3. Connect Carter's Apple Developer membership correctly

For an **organization** membership, Carter uses App Store Connect → Users and Access → add Cosme's own Apple Account as a Developer, enabling Certificates, Identifiers & Profiles access. Cosme accepts the invitation, adds that Apple Account in Xcode Settings → Accounts/Apple Accounts, and selects Carter's team under the app target's Signing & Capabilities. [Apple's user-management guide](https://developer.apple.com/help/app-store-connect/manage-your-team/add-and-edit-users/) describes the invitation controls.

For an **individual** membership, an App Store Connect invitation does not make Cosme a member of Carter's development team or grant signing-resource access. Carter must handle signing on his side, including the authorized EAS path, or arrange the necessary development signing assets privately. Cosme can finish Xcode, dependencies and simulator preparation while that is arranged. [Apple's accounts and roles guide](https://developer.apple.com/help/app-store-connect/manage-your-team/overview-of-accounts-and-roles/) explains this distinction.

Account authentication/2FA, signing private keys, `.p12` files, provisioning material and API `.p8` keys stay in the owners' private credential workflow. Report only whether team/signing access works; do not paste those materials or the phone UDID into the room or repo.

## 4. Prepare the real iPhone and build handoff

Connect the phone by USB, unlock it and complete the computer-trust prompts. Enable [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device) when required, including its restart/confirmation. Confirm the device is usable in Xcode's Devices and Simulators window and supported by the selected Xcode version.

Once Mobile's native project is available, open its `.xcworkspace`, select the real iPhone, verify the bundle identifier and signing team, and build/install. Coordinate one native build and one phone inference run at a time. A simulator build proves integration only; it does not satisfy the real-phone gate.

Mobile/Max then verify bundled or locally imported model assets, a new local answer with airplane mode on and Wi-Fi/Bluetooth off, and an encrypted record that survives force-quit/relaunch. Use Instruments on an appropriately signed device build for memory/timing; record exact app/model/runtime revisions and cold/warm conditions.

Cosme's agent should report one readiness handoff: Mac model/architecture, macOS, free disk, Xcode build and iPhone SDK, Node/Bundler/CocoaPods status, simulator availability, signing-team result, device recognition, and the precise remaining blocker. Mark every unrun item as pending. Mobile owns the next app build; Max owns the coordinated measurement slot.

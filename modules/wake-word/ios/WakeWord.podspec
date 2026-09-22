Pod::Spec.new do |s|
  s.name           = 'WakeWord'
  s.version        = '1.0.0'
  s.summary        = 'On-device wake word detection for CookMate'
  s.author         = 'CookMate'
  s.homepage       = 'https://github.com/kpmquockhanh/cookmate'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.dependency 'onnxruntime-objc', '~> 1.20.0'
  s.source_files = '**/*.{h,m,swift}'
  # NOT s.resources: WakeWord builds as a static framework (static_framework
  # above), and CocoaPods never copies a static framework's own Resources into
  # the app - only its compiled code gets linked in. resource_bundles produces
  # a separate WakeWord.bundle that the app's own "Copy Pods Resources" script
  # phase copies in, regardless of how the pod that declared it is linked.
  s.resource_bundles = { 'WakeWord' => ['../models/*.onnx'] }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end

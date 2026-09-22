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
  s.resources = ['../models/*.onnx']
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end

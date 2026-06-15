require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AmbientAudio'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.author         = 'PIN AI'
  s.homepage       = 'https://pin.ai'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # Silero VAD v5(CoreML/ANE)。FluidAudio 经 app Podfile 的 extraPods 从 git 引入
  # (CocoaPods trunk 未发布);见 apps/mobile/app.json expo-build-properties.extraPods。
  s.dependency 'FluidAudio'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

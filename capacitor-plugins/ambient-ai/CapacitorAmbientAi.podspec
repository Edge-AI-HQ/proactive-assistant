Pod::Spec.new do |s|
  s.name = 'CapacitorAmbientAi'
  s.version = '0.1.0'
  s.summary = 'Unified Capacitor plugin for ambient AI context collection'
  s.homepage = 'https://github.com/pin-ai/capacitor-plugins'
  s.license = 'MIT'
  s.author = 'PIN AI'
  s.source = { :git => 'https://github.com/pin-ai/capacitor-plugins.git', :tag => s.version }
  s.platforms = { :ios => '17.0' }
  s.swift_version = '5.9'
  s.source_files = 'ios/Sources/AmbientAi/**/*.swift'
  s.dependency 'Capacitor'
end

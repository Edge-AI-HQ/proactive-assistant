require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'AmbientModels'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.author         = 'PIN AI'
  s.homepage       = 'https://pin.ai'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # 端侧 LLM 推理(LlamaSwift = mattt/llama.swift SPM)经 #if canImport(LlamaSwift) 条件编译：
  # 没接 llama 时本模块照常编译，download / verify-header / delete / list 全功能；只是 LLM 生成
  # (generateTimelineEvent 等)不可用。接 llama 的 SPM 接线放 Milestone C(时间线消费它)，
  # 见 LlamaTextGenerationEngine.swift / ModelVerifier.swift 的 canImport guard。

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

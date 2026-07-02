import ExpoModulesCore
import AVKit
import UIKit

/// Expo view 模块:包 iOS 系统 AVRoutePickerView(AirPlay 路由选择器)。
/// 渲染官方 AirPlay 字形按钮,点击由系统弹出路由选择 sheet(位置系统托管)。
/// 与 dev 的 <audio controls> 投屏按钮是同一系统控件。tint 固定白色,契合播放条前景。
public final class AirplayRouteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AirplayRoute")

    View(AirplayRouteView.self) {}
  }
}

final class AirplayRouteView: ExpoView {
  private let picker = AVRoutePickerView()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picker.prioritizesVideoDevices = false
    let tint = UIColor(white: 1.0, alpha: 0.95)
    picker.tintColor = tint
    picker.activeTintColor = tint
    addSubview(picker)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
  }
}

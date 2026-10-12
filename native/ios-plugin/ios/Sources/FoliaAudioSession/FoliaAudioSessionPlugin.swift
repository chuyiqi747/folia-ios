import Foundation
import AVFoundation
import MediaPlayer
// ⚠️ 必须显式 import UIKit。
// 下面用到了 UIImage / UIColor / UIGraphicsImageRenderer（makePlaceholderArtwork
// 与 downloadArtwork 两处）。虽然 MediaPlayer 在多数 SDK 版本上会间接把 UIKit
// 带进来，但这属于「碰巧能过」—— 换 SDK 版本就可能报
// "cannot find type 'UIImage' in scope"，所以显式写上。
import UIKit
import Capacitor

// ============================================================================
// FoliaAudioSessionPlugin
//
// 目的：让 WKWebView 里的 HTMLAudioElement 在 iOS 上获得真正的「原生音乐播放器」
//      行为 —— 后台连续播放、锁屏元数据、锁屏 / 控制中心按钮、耳机线控、
//      电话打断恢复。
//
// 为什么必须在原生层做（纯 JS 做不到的部分）：
//
//   1. AVAudioSession 的 category 只能由原生设置。
//      WKWebView 默认用 .ambient / .soloAmbient，一旦 App 退到后台，
//      系统会立刻停掉音频会话。必须显式设为 .playback 才允许后台出声。
//      （Info.plist 的 UIBackgroundModes=audio 是前提，这里是必要条件。）
//
//   2. MPNowPlayingInfoCenter 的「正在播放」信息，WKWebView 里只有
//      navigator.mediaSession 一条路，而它在原生壳中的表现不完全可控：
//      - 封面 artwork 在 iOS 16.1 一度回归性失效（16.3 才修）
//      - 进度条（elapsed / duration）更新时机不受我们控制
//      - iOS 16+ 设置单个 action handler 会清掉其它默认绑定
//      走原生 MPNowPlayingInfoCenter 可以完全掌握这些字段。
//
//   3. MPRemoteCommandCenter 是锁屏按钮的唯一接入点。
//      WKWebView 的 mediaSession action handler 在部分 iOS 版本上
//      收不到耳机线控 / 车机的命令，原生接管可以拿到全部。
//
//   4. AVAudioSession.interruptionNotification 提供电话 / 闹钟打断事件，
//      这是记录「用户是被打断而不是主动暂停」的唯一途径。
//
// 设计取舍：
//   - 音频仍然由 WKWebView 的 <audio> 解码播放（不换成 AVPlayer）。
//     换成 AVPlayer 意味着要重写整个播放管线、跨域、鉴权、缓存都要重做，
//     收益不明显。原生层只负责「会话 + 元数据 + 远程命令」，
//     位置与状态由 JS 通过 updateNowPlaying 同步过来。
//   - 因此 JS 必须在前台时持续推送进度（每 1s 一次即可，iOS 会自动插值）。
// ============================================================================

@objc(FoliaAudioSessionPlugin)
public class FoliaAudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "FoliaAudioSessionPlugin"
    public let jsName = "FoliaAudioSession"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deactivate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAudioSessionInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNowPlayingInfo", returnType: CAPPluginReturnPromise)
    ]

    // Remote command 的 target 需要保持强引用，否则会被系统回收，按钮全失效。
    private var registeredCommands: [MPRemoteCommand] = []

    // 记录当前是否处于被打断状态，用于恢复时判断该不该自动续播。
    private var isInterrupted = false
    // 打断前的播放状态，恢复时据此决定是否自动 resume。
    private var wasPlayingBeforeInterruption = false

    // AVAudioSession 不暴露「当前是否 active」，自己记一个。
    // 只用于 getNowPlayingInfo 的诊断输出。
    private var isSessionActive = false

    // MARK: - Lifecycle

    @objc override public func load() {
        // 插件加载时就把会话类别配好，不要等到 JS 调用 activate。
        // 原因：用户可能在 JS 初始化完成前就点了播放，晚配会导致首播没声音。
        configureAudioSession()

        registerRemoteCommands()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Audio session

    /// 配置 AVAudioSession：这是「后台能不能出声」的总开关。
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // .playback 表示「这是内容播放，不是录音也不是提示音」，
            // 它与 UIBackgroundModes=audio 配合才能后台播放。
            // mode 保持 .default：.longFormAudio 是为有声书 / 播客设计的，
            // 用于音乐反而会让部分系统版本在切歌时产生额外的缓冲停顿。
            try session.setCategory(.playback, mode: .default, options: [])

            // 允许 AirPlay / 蓝牙 / 车机的远程控制（锁屏按钮、方向盘按键）。
            try session.setActive(true)
            isSessionActive = true
        } catch {
            isSessionActive = false
            CAPLog.print("[FoliaAudioSession] Failed to configure session: \(error)")
        }
    }

    @objc func activate(_ call: CAPPluginCall) {
        configureAudioSession()
        call.resolve([
            "category": AVAudioSession.sharedInstance().category.rawValue,
            "sampleRate": AVAudioSession.sharedInstance().sampleRate,
            "outputVolume": AVAudioSession.sharedInstance().outputVolume
        ])
    }

    /// 诊断用：一次性把「音频会话 + 正在播放信息 + 远程命令」的真实状态回给 JS。
    ///
    /// 为什么需要：iOS 上这些状态在设备端看不见，出问题时只能靠猜。
    /// 有了它，设置页就能直接显示「会话类别是不是 playback / 有没有激活 /
    /// Now Playing 有没有内容 / 锁屏按钮注册了几个」，一眼定位。
    @objc func getNowPlayingInfo(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]

        var playbackStateName = "unknown"
        if #available(iOS 13.0, *) {
            switch MPNowPlayingInfoCenter.default().playbackState {
            case .playing: playbackStateName = "playing"
            case .paused: playbackStateName = "paused"
            case .stopped: playbackStateName = "stopped"
            @unknown default: playbackStateName = "unknown"
            }
        }

        call.resolve([
            "sessionCategory": session.category.rawValue,
            "sessionMode": session.mode.rawValue,
            "sessionActive": isSessionActive,
            "sampleRate": session.sampleRate,
            "outputVolume": session.outputVolume,
            "hasNowPlayingInfo": !info.isEmpty,
            "title": (info[MPMediaItemPropertyTitle] as? String) ?? "",
            "artist": (info[MPMediaItemPropertyArtist] as? String) ?? "",
            "playbackRate": (info[MPNowPlayingInfoPropertyPlaybackRate] as? Double) ?? 0,
            "elapsed": (info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double) ?? 0,
            "duration": (info[MPMediaItemPropertyPlaybackDuration] as? Double) ?? 0,
            "hasArtwork": info[MPMediaItemPropertyArtwork] != nil,
            "playbackState": playbackStateName,
            "registeredCommandCount": registeredCommands.count
        ])
    }

    @objc func deactivate(_ call: CAPPluginCall) {
        // ⚠️ 不要真的 setActive(false)。
        // 一旦释放会话，正在播放的音频会被系统掐断，
        // 而且重新激活有延迟，切歌时会听到断续。
        // 这里只清掉「正在播放」信息，保留会话。
        clearNowPlayingInfo()
        call.resolve()
    }

    @objc func getAudioSessionInfo(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        call.resolve([
            "category": session.category.rawValue,
            "isOtherAudioPlaying": session.isOtherAudioPlaying,
            "outputVolume": session.outputVolume,
            "sampleRate": session.sampleRate
        ])
    }

    // MARK: - Now Playing metadata

    /// 由 JS 在歌曲切换时调用。
    ///
    /// - Parameters:
    ///   - title / artist / album：展示在锁屏与车机上的文本
    ///   - duration：秒，用于进度条总量
    ///   - elapsed：秒，当前播放位置
    ///   - artworkUrl：封面地址。**只在能拿到本地文件或已下载数据时才有意义**，
    ///                 远程 URL 需要先下载成 Data，见 downloadArtwork。
    @objc func updateNowPlaying(_ call: CAPPluginCall) {
        guard let title = call.getString("title") else {
            call.reject("title is required")
            return
        }

        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? ""
        let duration = call.getDouble("duration") ?? 0
        let elapsed = call.getDouble("elapsed") ?? 0
        let playbackRate = call.getDouble("playbackRate") ?? 1.0
        let artworkUrl = call.getString("artworkUrl")

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyAlbumTitle: album,
            MPMediaItemPropertyPlaybackDuration: duration,
            // elapsed 与 rate 一起给，系统才能让进度条平滑走。
            // 只给 elapsed 不给 rate，进度条会卡在初始值。
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: playbackRate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0
        ]

        // 有封面就先塞一个空的占位，让锁屏立刻出信息，图片到了再替换。
        // 不这样做的话，等图片下载完（可能几百毫秒）锁屏会一片空白。
        if let urlString = artworkUrl, !urlString.isEmpty {
            info[MPMediaItemPropertyArtwork] = makePlaceholderArtwork()
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        // ⚠️ iOS 13+ 必须显式维护 playbackState。
        // 只设 nowPlayingInfo 而不设 playbackState 时，锁屏 / 控制中心的
        // 「正在播放」卡片在部分系统版本上不会出现（或出现后不显示按钮）。
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = playbackRate > 0 ? .playing : .paused
        }

        // 异步拉取封面。注意这里是 native 层下载，
        // 不受 WKWebView 跨域限制，比 JS 侧处理省心。
        if let urlString = artworkUrl, !urlString.isEmpty {
            downloadArtwork(urlString) { [weak self] image in
                guard let self, let image else { return }
                // 再取一次当前 info，避免覆盖掉期间更新过的进度。
                var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                updated[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(
                    boundsSize: image.size,
                    requestHandler: { _ in image }
                )
                MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
                self.notifyListeners("artworkLoaded", data: ["url": urlString])
            }
        }

        call.resolve()
    }

    /// 单独推送播放状态变化。与 updateNowPlaying 分开，
    /// 因为播放 / 暂停的触发频率远高于歌曲切换。
    @objc func setPlaybackState(_ call: CAPPluginCall) {
        guard let state = call.getString("state") else {
            call.reject("state is required")
            return
        }

        let isPlaying: Bool
        switch state {
        case "playing": isPlaying = true
        case "paused", "stopped", "none": isPlaying = false
        default:
            call.reject("unknown state: \(state)")
            return
        }

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        // ⚠️ 必须同时更新 elapsed，否则从暂停恢复时进度条会跳回上次的锚点。
        if let elapsed = call.getDouble("elapsed") {
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        // 与 updateNowPlaying 一样，playbackState 必须同步维护。
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
        }

        call.resolve()
    }

    /// 高频调用（建议 1s 一次），只更新进度锚点。
    /// 独立成一个方法是为了让它尽可能轻，避免每次重设整个 info 字典。
    @objc func updateProgress(_ call: CAPPluginCall) {
        guard let elapsed = call.getDouble("elapsed") else {
            call.reject("elapsed is required")
            return
        }

        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        if let duration = call.getDouble("duration"), duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let rate = call.getDouble("playbackRate") {
            info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        call.resolve()
    }

    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        clearNowPlayingInfo()
        call.resolve()
    }

    private func clearNowPlayingInfo() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = .stopped
        }
    }

    // MARK: - Artwork

    private func makePlaceholderArtwork() -> MPMediaItemArtwork {
        // 1x1 透明图，仅用于让锁屏先出现一个合法的 artwork 字段，
        // 避免「有标题但封面区域空白」的突兀感。
        let size = CGSize(width: 1, height: 1)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { ctx in
            UIColor.clear.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
        return MPMediaItemArtwork(boundsSize: size, requestHandler: { _ in image })
    }

    private func downloadArtwork(_ urlString: String, completion: @escaping (UIImage?) -> Void) {
        guard let url = URL(string: urlString) else {
            completion(nil)
            return
        }

        // 本地文件（capacitor:// 或 file://）直接读，不走网络。
        if url.isFileURL {
            completion(UIImage(contentsOfFile: url.path))
            return
        }

        URLSession.shared.dataTask(with: url) { data, _, error in
            guard let data, error == nil, let image = UIImage(data: data) else {
                CAPLog.print("[FoliaAudioSession] artwork fetch failed: \(error?.localizedDescription ?? "bad data")")
                completion(nil)
                return
            }
            DispatchQueue.main.async { completion(image) }
        }.resume()
    }

    // MARK: - Remote commands (锁屏 / 控制中心 / 耳机 / 车机)

    private func registerRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        // ⚠️ iOS 16+ 的坑：注册任何一个 command 时如果前一个 command 的
        // enabled 状态是 false，系统可能不显示对应按钮。
        // 这里统一先把 enabled 打开，再挂 handler。

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            self?.emitRemoteCommand("play")
            return .success
        }

        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            self?.emitRemoteCommand("pause")
            return .success
        }

        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.emitRemoteCommand("togglePlayPause")
            return .success
        }

        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.emitRemoteCommand("nextTrack")
            return .success
        }

        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.emitRemoteCommand("previousTrack")
            return .success
        }

        // seek：锁屏拖动进度条。changePlaybackPositionCommand 给的是绝对位置。
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.notifyListeners("remoteCommand", data: [
                "command": "seek",
                "position": positionEvent.positionTime
            ])
            return .success
        }

        // 快进 / 快退（部分车机与耳机提供）
        center.skipForwardCommand.isEnabled = true
        center.skipForwardCommand.preferredIntervals = [15]
        center.skipForwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 15
            self?.notifyListeners("remoteCommand", data: [
                "command": "skipForward",
                "interval": interval
            ])
            return .success
        }

        center.skipBackwardCommand.isEnabled = true
        center.skipBackwardCommand.preferredIntervals = [15]
        center.skipBackwardCommand.addTarget { [weak self] event in
            let interval = (event as? MPSkipIntervalCommandEvent)?.interval ?? 15
            self?.notifyListeners("remoteCommand", data: [
                "command": "skipBackward",
                "interval": interval
            ])
            return .success
        }

        registeredCommands = [
            center.playCommand,
            center.pauseCommand,
            center.togglePlayPauseCommand,
            center.nextTrackCommand,
            center.previousTrackCommand,
            center.changePlaybackPositionCommand,
            center.skipForwardCommand,
            center.skipBackwardCommand
        ]
    }

    private func emitRemoteCommand(_ name: String) {
        notifyListeners("remoteCommand", data: ["command": name])
    }

    // MARK: - Interruptions (电话、闹钟、其它 App 抢占)

    @objc private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            // 被打断开始。此时音频已经被系统停了，
            // 我们的责任是「记住用户原本在播」，等恢复时决定要不要续播。
            isInterrupted = true
            // ⚠️ 注意括号：?? 的优先级低于 >，写成 `as? Double ?? 0 > 0`
            // 会被解析成 `as? Double ?? (0 > 0)`，类型不匹配且语义全错。
            let rate = (MPNowPlayingInfoCenter.default()
                .nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? Double) ?? 0
            wasPlayingBeforeInterruption = rate > 0

            notifyListeners("interruption", data: [
                "phase": "began",
                "wasPlaying": wasPlayingBeforeInterruption
            ])

        case .ended:
            isInterrupted = false

            let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            // 只有系统说「应该恢复」时才续播。
            // 如果打断来自其它音乐 App（用户主动切走了），这里不会带 shouldResume，
            // 我们就不该抢回播放权 —— 那是很讨人厌的行为。
            let shouldResume = options.contains(.shouldResume)

            // 重新激活会话：打断结束后会话会处于非激活状态，
            // 不重新 setActive 的话后续播放会静默失败。
            configureAudioSession()

            notifyListeners("interruption", data: [
                "phase": "ended",
                "shouldResume": shouldResume,
                "wasPlaying": wasPlayingBeforeInterruption
            ])

        @unknown default:
            break
        }
    }

    // MARK: - Route change (拔耳机 / 蓝牙断开)

    @objc private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        switch reason {
        case .oldDeviceUnavailable:
            // 耳机被拔出 / 蓝牙断开。
            // 业界惯例（也是 Apple 推荐）是自动暂停 —— 突然外放会吓到用户。
            notifyListeners("routeChange", data: [
                "reason": "oldDeviceUnavailable",
                "shouldPause": true
            ])
        case .newDeviceAvailable:
            notifyListeners("routeChange", data: [
                "reason": "newDeviceAvailable",
                "shouldPause": false
            ])
        default:
            break
        }
    }
}

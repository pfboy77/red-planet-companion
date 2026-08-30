import Foundation

@MainActor
protocol MultiplayerClient: AnyObject {
    var onMessage: (([String: Any]) -> Void)? { get set }
    var onDisconnect: (() -> Void)? { get set }

    func connect(to url: URL)
    @discardableResult func send(_ message: [String: Any]) -> Bool
    func disconnect()
}

@MainActor
final class LocalMultiplayerClient: MultiplayerClient {
    var onMessage: (([String: Any]) -> Void)?
    var onDisconnect: (() -> Void)?
    private var task: URLSessionWebSocketTask?

    func connect(to url: URL) {
        disconnect()
        let nextTask = URLSession.shared.webSocketTask(with: url)
        task = nextTask
        nextTask.resume()
        receive(from: nextTask)
    }

    @discardableResult
    func send(_ message: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8),
              let task,
              task.state == .running else { return false }
        task.send(.string(text)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                guard let self, self.task === task else { return }
                self.task = nil
                self.onDisconnect?()
            }
        }
        return true
    }

    func disconnect() {
        let previousTask = task
        task = nil
        previousTask?.cancel(with: .normalClosure, reason: nil)
    }

    private func receive(from task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === task else { return }
                switch result {
                case .success(let message):
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        self.onMessage?(object)
                    }
                    self.receive(from: task)
                case .failure:
                    self.task = nil
                    self.onDisconnect?()
                }
            }
        }
    }
}

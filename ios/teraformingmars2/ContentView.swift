import SwiftUI

enum MainTab: Hashable {
    case home
    case resources
    case players
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel = GameViewModel()
    @State private var selectedTab: MainTab = .home

    var body: some View {
        VStack(spacing: 0) {
            ScreenNavigationBar(selectedTab: $selectedTab)
            Group {
                switch selectedTab {
                case .home:
                    HomeView(viewModel: viewModel, enterGame: { selectedTab = .resources })
                case .resources:
                    ResourceManagementView(viewModel: viewModel)
                case .players:
                    OtherPlayersView(viewModel: viewModel)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onChange(of: viewModel.gameMode) { _, mode in
            selectedTab = mode == .none ? .home : .resources
        }
        .onChange(of: scenePhase) { _, phase in
            viewModel.handleScenePhase(isActive: phase == .active)
        }
    }
}

private struct ScreenNavigationBar: View {
    @Binding var selectedTab: MainTab

    var body: some View {
        HStack(spacing: 12) {
            if selectedTab == .resources {
                Button {
                    selectedTab = .home
                } label: {
                    Label("戻る", systemImage: "chevron.left")
                }
                .accessibilityIdentifier("backScreenButton")
            } else if selectedTab == .players {
                Button {
                    selectedTab = .resources
                } label: {
                    Label("資源管理", systemImage: "cube.box")
                }
                .accessibilityIdentifier("backScreenButton")
            } else {
                Color.clear.frame(width: 112, height: 32)
            }

            Spacer(minLength: 4)
            Text(title).font(.headline)
            Spacer(minLength: 4)

            if selectedTab == .resources {
                Button {
                    selectedTab = .players
                } label: {
                    Label("プレイヤー", systemImage: "person.3")
                }
                .accessibilityIdentifier("nextScreenButton")
            } else {
                Color.clear.frame(width: 112, height: 32)
            }
        }
        .frame(height: 48)
        .padding(.horizontal)
        .background(.bar)
    }

    private var title: String {
        switch selectedTab {
        case .home: "ホーム"
        case .resources: "自分の資源管理"
        case .players: "他プレイヤー"
        }
    }
}

#Preview {
    ContentView()
}

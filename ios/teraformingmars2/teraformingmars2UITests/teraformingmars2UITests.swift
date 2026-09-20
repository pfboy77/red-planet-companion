import XCTest

final class teraformingmars2UITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-UITesting"]
        app.launch()
    }

    override func tearDownWithError() throws {
        app.terminate()
    }

    func testAboutPrivacySupportAndDeleteConfirmation() {
        app.buttons["startSoloButton"].tap()
        app.buttons["Increase TR"].tap()
        app.buttons["backScreenButton"].tap()
        app.buttons["aboutButton"].tap()
        XCTAssertTrue(app.staticTexts["appVersion"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.links["privacyLink"].exists || app.buttons["privacyLink"].exists)
        XCTAssertTrue(app.links["supportLink"].exists || app.buttons["supportLink"].exists)
        app.swipeUp()
        app.buttons["deleteLocalDataButton"].tap()
        app.buttons["キャンセル"].tap()
        app.buttons["完了"].tap()
        app.buttons["startSoloButton"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 21"].exists)
        app.buttons["backScreenButton"].tap()
        app.buttons["aboutButton"].tap()
        app.swipeUp()
        app.buttons["deleteLocalDataButton"].tap()
        app.buttons["すべての保存データを削除"].tap()
        XCTAssertTrue(app.buttons["startSoloButton"].waitForExistence(timeout: 2))
        app.terminate()
        app.launchArguments = ["-UITesting", "-UITestingPreserveData"]
        app.launch()
        app.buttons["startSoloButton"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 20"].waitForExistence(timeout: 2))
    }

    func testUnreachableServerCanBeForgottenBeforeSolo() {
        app.terminate()
        app.launchArguments = ["-UITesting", "-UITestingOfflineResume"]
        app.launch()
        app.buttons["startSoloButton"].tap()
        let discard = app.buttons["再接続情報をこの端末から削除してソロを開始"]
        XCTAssertTrue(discard.waitForExistence(timeout: 10))
        app.buttons["キャンセル"].tap()
        XCTAssertTrue(app.buttons["resumeRoomButton"].exists)
        app.buttons["startSoloButton"].tap()
        XCTAssertTrue(discard.waitForExistence(timeout: 10))
        discard.tap()
        app.buttons["削除してソロを開始"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 20"].waitForExistence(timeout: 2))
    }

    func testAppLaunchesOnHome() {
        XCTAssertTrue(app.buttons["startSoloButton"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["nextScreenButton"].exists)
    }

    func testSoloModeShowsResourcesAndTRUpdatesCanBeUndone() {
        app.buttons["startSoloButton"].tap()
        app.buttons["Reset all resources"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 20"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["MC"].exists)
        app.buttons["Increase TR"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 21"].waitForExistence(timeout: 1))
        app.buttons["Undo"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 20"].waitForExistence(timeout: 1))
    }

    func testScreenNavigationPreservesSoloState() {
        app.buttons["startSoloButton"].tap()
        app.buttons["Reset all resources"].tap()
        app.buttons["Increase TR"].tap()
        app.buttons["nextScreenButton"].tap()
        XCTAssertTrue(app.staticTexts["ソロモードでは他プレイヤーは表示されません"].waitForExistence(timeout: 1))
        app.buttons["backScreenButton"].tap()
        XCTAssertTrue(app.staticTexts["Terraform Rating 21"].waitForExistence(timeout: 1))
    }

    func testResourcesRemainReachableInLandscape() {
        app.buttons["startSoloButton"].tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        let resources = app.scrollViews.firstMatch
        XCTAssertTrue(resources.waitForExistence(timeout: 2))
        resources.swipeUp()
        XCTAssertTrue(app.staticTexts["Heat"].waitForExistence(timeout: 1))
        XCUIDevice.shared.orientation = .portrait
    }
}

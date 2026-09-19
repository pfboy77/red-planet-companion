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

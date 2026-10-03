package com.roadtrip.copilot

import android.content.Context
import android.os.Bundle
import androidx.car.app.OnDoneCallback
import androidx.car.app.ScreenManager
import androidx.car.app.model.Action
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.testing.ScreenController
import androidx.car.app.testing.TestCarContext
import androidx.lifecycle.Lifecycle
import androidx.car.app.testing.TestScreenManager
import androidx.test.core.app.ApplicationProvider
import com.roadtrip.copilot.car.RouteListScreen
import com.roadtrip.copilot.model.AssetProvider
import com.roadtrip.copilot.model.RouteOption
import com.roadtrip.copilot.model.RouteRepository
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class RouteListScreenTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var context: Context
    private lateinit var testCarContext: TestCarContext
    private lateinit var testScreenManager: TestScreenManager
    private lateinit var testStorageDir: File

    private val dummyCallback = object : OnDoneCallback {}

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        testCarContext = TestCarContext.createCarContext(context)
        testScreenManager = testCarContext.getCarService(ScreenManager::class.java) as TestScreenManager
        testStorageDir = tempFolder.newFolder("test_itineraries")

        // Reset CopilotService static state before each test
        CopilotService.setSelectedRoute(
            context = context,
            routeFile = "sample_itinerary.json",
            dayNumber = 1,
            autoRestartIfRunning = false
        )
    }

    private fun createRepositoryWithRoutes(routes: List<RouteOption>): RouteRepository {
        val repo = RouteRepository(
            storageDir = testStorageDir,
            assetProvider = AssetProvider { null }
        )
        // Access private _routes flow via reflection to seed exact mock routes for isolated UI tests
        val routesField = RouteRepository::class.java.getDeclaredField("_routes")
        routesField.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val mutableFlow = routesField.get(repo) as kotlinx.coroutines.flow.MutableStateFlow<List<RouteOption>>
        mutableFlow.value = routes
        return repo
    }

    /**
     * Invariant 1: onGetTemplate() returns rows matching RouteRepository options.
     */
    @Test
    fun testScenario1_OnGetTemplateReturnsRowsMatchingRouteRepositoryOptions() {
        val sampleRoutes = listOf(
            RouteOption(
                title = "Route Alpha",
                routeFile = "alpha.json",
                dayNumber = 1,
                subtitle = "Alpha subtitle"
            ),
            RouteOption(
                title = "Route Beta",
                routeFile = "beta.json",
                dayNumber = 2,
                subtitle = "Beta subtitle"
            ),
            RouteOption(
                title = "Route Gamma",
                routeFile = "gamma.json",
                dayNumber = 3,
                subtitle = "Gamma subtitle"
            )
        )
        val repository = createRepositoryWithRoutes(sampleRoutes)
        val screen = RouteListScreen(testCarContext, repository)

        val template = screen.onGetTemplate()
        assertTrue("Template must be a ListTemplate", template is ListTemplate)
        val listTemplate = template as ListTemplate

        val items = listTemplate.singleList?.items ?: emptyList()
        assertEquals("Should display exactly 3 route rows", 3, items.size)

        for (i in sampleRoutes.indices) {
            val expectedOption = sampleRoutes[i]
            val row = items[i] as Row
            val titleText = row.title?.toString() ?: ""
            val subtitleText = row.texts.firstOrNull()?.toString() ?: ""

            assertTrue("Row $i title should contain route title", titleText.contains(expectedOption.title))
            assertEquals("Row $i subtitle should match", expectedOption.subtitle, subtitleText)
        }
    }

    /**
     * Invariant 2: Selected route item is visually decorated with the "✓ " prefix,
     * while unselected items do not have the prefix.
     */
    @Test
    fun testScenario2_SelectedRouteItemDecoratedWithCheckmarkPrefix() {
        val sampleRoutes = listOf(
            RouteOption(
                title = "Outbound Run",
                routeFile = "outbound.json",
                dayNumber = 1,
                subtitle = "Leg 1"
            ),
            RouteOption(
                title = "Return Run",
                routeFile = "return.json",
                dayNumber = 1,
                subtitle = "Leg 2"
            )
        )
        val repository = createRepositoryWithRoutes(sampleRoutes)

        // Select the second route in CopilotService
        CopilotService.setSelectedRoute(
            context = context,
            routeFile = "return.json",
            dayNumber = 1,
            autoRestartIfRunning = false
        )

        val screen = RouteListScreen(testCarContext, repository)
        val template = screen.onGetTemplate() as ListTemplate
        val items = template.singleList?.items ?: emptyList()
        assertEquals(2, items.size)

        val row0 = items[0] as Row
        val row1 = items[1] as Row

        val row0Title = row0.title?.toString() ?: ""
        val row1Title = row1.title?.toString() ?: ""

        assertFalse("Unselected route must NOT have '✓ ' prefix", row0Title.startsWith("✓ "))
        assertEquals("Outbound Run", row0Title)

        assertTrue("Selected route MUST have '✓ ' prefix", row1Title.startsWith("✓ "))
        assertEquals("✓ Return Run", row1Title)

        // Dynamically switch selection to the first route
        CopilotService.setSelectedRoute(
            context = context,
            routeFile = "outbound.json",
            dayNumber = 1,
            autoRestartIfRunning = false
        )

        val updatedTemplate = screen.onGetTemplate() as ListTemplate
        val updatedItems = updatedTemplate.singleList?.items ?: emptyList()
        val updatedRow0 = updatedItems[0] as Row
        val updatedRow1 = updatedItems[1] as Row

        assertTrue("Now first route must have '✓ ' prefix", updatedRow0.title?.toString()?.startsWith("✓ ") == true)
        assertFalse("Second route must lose '✓ ' prefix", updatedRow1.title?.toString()?.startsWith("✓ ") == true)
    }

    /**
     * Invariant 3: Clicking an item updates CopilotService selection and pops the screen.
     */
    @Test
    fun testScenario3_ClickingItemUpdatesCopilotServiceAndPopsScreen() {
        val sampleRoutes = listOf(
            RouteOption(
                title = "Day 1: Phoenix to Sedona",
                routeFile = "sample_itinerary.json",
                dayNumber = 1,
                subtitle = "Scenic Red Rocks"
            ),
            RouteOption(
                title = "Day 2: Flagstaff to Chama",
                routeFile = "sample_itinerary.json",
                dayNumber = 2,
                subtitle = "High Desert"
            )
        )
        val repository = createRepositoryWithRoutes(sampleRoutes)

        // Set initial selection to Day 1
        CopilotService.setSelectedRoute(
            context = context,
            routeFile = "sample_itinerary.json",
            dayNumber = 1,
            autoRestartIfRunning = false
        )
        assertEquals("sample_itinerary.json", CopilotService.activeRouteFile.value)
        assertEquals(1, CopilotService.activeDayNumber.value)

        val rootScreen = object : androidx.car.app.Screen(testCarContext) {
            override fun onGetTemplate(): androidx.car.app.model.Template {
                val pane = androidx.car.app.model.Pane.Builder()
                    .addRow(androidx.car.app.model.Row.Builder().setTitle("Root").build())
                    .build()
                return androidx.car.app.model.PaneTemplate.Builder(pane)
                    .setTitle("Root")
                    .build()
            }
        }
        ScreenController(rootScreen).moveToState(Lifecycle.State.RESUMED)
        testScreenManager.push(rootScreen)

        val screen = RouteListScreen(testCarContext, repository)
        ScreenController(screen).moveToState(Lifecycle.State.RESUMED)
        testScreenManager.push(screen)

        val template = screen.onGetTemplate() as ListTemplate
        val items = template.singleList?.items ?: emptyList()
        val day2Row = items[1] as Row

        // Click the second route (Day 2)
        val clickDelegate = day2Row.onClickDelegate
        assertNotNull("Row must have OnClickDelegate", clickDelegate)
        clickDelegate?.sendClick(dummyCallback)

        // Verify CopilotService was updated
        assertEquals("CopilotService activeRouteFile must match clicked route", "sample_itinerary.json", CopilotService.activeRouteFile.value)
        assertEquals("CopilotService activeDayNumber must match clicked route", 2, CopilotService.activeDayNumber.value)

        // Verify screen was popped
        assertTrue("Screen must be popped from ScreenManager", testScreenManager.screensRemoved.contains(screen))
    }

    /**
     * Invariant 4: Driving distraction / 6-item pagination limits.
     * When repository contains > 6 routes, ItemList NEVER contains more than 6 items,
     * and pagination controls in ActionStrip allow navigating between pages.
     */
    @Test
    fun testScenario4_PaginationEnforcesMax6ItemsPerListAndProvidesNavigation() {
        val eightRoutes = (1..8).map { num ->
            RouteOption(
                title = "Route $num",
                routeFile = "route_$num.json",
                dayNumber = num,
                subtitle = "Subtitle $num"
            )
        }
        val repository = createRepositoryWithRoutes(eightRoutes)

        // Set initial active route to Route 1 so initial page is 0
        CopilotService.setSelectedRoute(
            context = context,
            routeFile = "route_1.json",
            dayNumber = 1,
            autoRestartIfRunning = false
        )

        val screen = RouteListScreen(testCarContext, repository)
        assertEquals("Should calculate 2 total pages for 8 items", 2, screen.getTotalPages())
        assertEquals("Initial page should be 0", 0, screen.getCurrentPage())

        // Page 1: Check items and limit
        val page1Template = screen.onGetTemplate() as ListTemplate
        val page1Items = page1Template.singleList?.items ?: emptyList()
        assertEquals("Page 1 must contain exactly 6 items", 6, page1Items.size)
        assertTrue("Item count must not exceed Android Auto 6-item limit", page1Items.size <= RouteListScreen.MAX_ITEMS_PER_PAGE)
        assertEquals("Title should reflect pagination", "Select Route (1/2)", page1Template.title?.toString())

        // Page 1 ActionStrip should have "Next ▶" action
        val page1ActionStrip = page1Template.actionStrip
        assertNotNull("ActionStrip must be present for multi-page list", page1ActionStrip)
        val page1Actions = page1ActionStrip?.actions ?: emptyList()
        assertEquals("Page 1 should have 1 navigation action (Next)", 1, page1Actions.size)
        val nextAction = page1Actions[0]
        assertEquals("Next ▶", nextAction.title?.toString())

        // Click "Next ▶"
        nextAction.onClickDelegate?.sendClick(dummyCallback)
        assertEquals("Current page should now be 1", 1, screen.getCurrentPage())

        // Page 2: Check items and limit
        val page2Template = screen.onGetTemplate() as ListTemplate
        val page2Items = page2Template.singleList?.items ?: emptyList()
        assertEquals("Page 2 must contain remaining 2 items", 2, page2Items.size)
        assertTrue("Item count must not exceed Android Auto 6-item limit", page2Items.size <= RouteListScreen.MAX_ITEMS_PER_PAGE)
        assertEquals("Title should reflect page 2", "Select Route (2/2)", page2Template.title?.toString())

        val page2Row0 = page2Items[0] as Row
        assertTrue("Page 2 first row should be Route 7", page2Row0.title?.toString()?.contains("Route 7") == true)

        // Page 2 ActionStrip should have "◀ Prev" action
        val page2ActionStrip = page2Template.actionStrip
        assertNotNull("ActionStrip must be present on page 2", page2ActionStrip)
        val page2Actions = page2ActionStrip?.actions ?: emptyList()
        assertEquals("Page 2 should have 1 navigation action (Prev)", 1, page2Actions.size)
        val prevAction = page2Actions[0]
        assertEquals("◀ Prev", prevAction.title?.toString())

        // Click "◀ Prev"
        prevAction.onClickDelegate?.sendClick(dummyCallback)
        assertEquals("Current page should now return to 0", 0, screen.getCurrentPage())
    }

    /**
     * Invariant 5: Title and subtitle fallback formatting when empty or null.
     */
    @Test
    fun testScenario5_TitleAndSubtitleFallbackFormatting() {
        val blankRoutes = listOf(
            RouteOption(
                title = "",
                routeFile = "custom1.json",
                dayNumber = 3,
                subtitle = null
            ),
            RouteOption(
                title = "",
                routeFile = "custom2.json",
                dayNumber = 0,
                subtitle = ""
            )
        )
        val repository = createRepositoryWithRoutes(blankRoutes)
        val screen = RouteListScreen(testCarContext, repository)

        val template = screen.onGetTemplate() as ListTemplate
        val items = template.singleList?.items ?: emptyList()
        assertEquals(2, items.size)

        val row0 = items[0] as Row
        val row1 = items[1] as Row

        // row0: dayNumber = 3 -> falls back to "Day 3"
        assertEquals("Day 3", row0.title?.toString())
        assertEquals("Day 3", row0.texts.firstOrNull()?.toString())

        // row1: dayNumber = 0 -> falls back to "Custom Route"
        assertEquals("Custom Route", row1.title?.toString())
        assertEquals("Custom Route", row1.texts.firstOrNull()?.toString())
    }

    /**
     * Invariant 6: Graceful handling of empty route repository.
     */
    @Test
    fun testScenario6_EmptyRoutesListDisplaysPlaceholderGracefully() {
        val repository = createRepositoryWithRoutes(emptyList())
        val screen = RouteListScreen(testCarContext, repository)

        val template = screen.onGetTemplate() as ListTemplate
        val items = template.singleList?.items ?: emptyList()
        assertEquals("Should display 1 placeholder row when empty", 1, items.size)

        val placeholder = items[0] as Row
        assertEquals("No routes available", placeholder.title?.toString())
        assertEquals("Import a route in phone app", placeholder.texts.firstOrNull()?.toString())
        assertEquals("Select Itinerary Route", template.title?.toString())
        assertNull("No ActionStrip when totalPages is 1", template.actionStrip)
    }

    /**
     * Invariant 7: Default constructor initializes using RouteRepository.getInstance(carContext).
     */
    @Test
    fun testScenario7_DefaultConstructorUsesRouteRepositorySingleton() {
        val screen = RouteListScreen(testCarContext)
        assertNotNull("Screen must initialize with default repository", screen)

        val template = screen.onGetTemplate() as ListTemplate
        val items = template.singleList?.items ?: emptyList()
        // When repository has no stored routes, displays 1 placeholder item
        assertEquals(1, items.size)
        val row = items[0] as Row
        assertEquals("No routes available", row.title?.toString())
    }

    /**
     * Invariant 8: Initial page aligns with active route when active route is on later page.
     */
    @Test
    fun testScenario8_InitialPageSynchronizesToActiveRoutePage() {
        val tenRoutes = (1..10).map { num ->
            RouteOption(
                title = "Route $num",
                routeFile = "route_$num.json",
                dayNumber = num,
                subtitle = "Subtitle $num"
            )
        }
        val repository = createRepositoryWithRoutes(tenRoutes)

        // Set active route to Route 9 (index 8, which belongs to Page 1)
        CopilotService.setSelectedRoute(
            context = context,
            routeFile = "route_9.json",
            dayNumber = 9,
            autoRestartIfRunning = false
        )

        val screen = RouteListScreen(testCarContext, repository)
        assertEquals("Initial page should be 1 because Route 9 is at index 8", 1, screen.getCurrentPage())

        val template = screen.onGetTemplate() as ListTemplate
        val items = template.singleList?.items ?: emptyList()
        assertEquals(4, items.size) // Routes 7, 8, 9, 10 on page 1

        val route9Row = items[2] as Row
        assertTrue("Route 9 should have checkmark", route9Row.title?.toString()?.startsWith("✓ ") == true)
    }
}

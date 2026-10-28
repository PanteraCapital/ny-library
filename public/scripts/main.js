$(document).ready(function() {
  var $window = $(window)
  var $document = $(document)
  var $html = $('html')

  $("pre code").html(function (index, html) {
    return html.split(/\r?\n/).map(function(line) {
      return [
        '<div class="line">',
          '<div class="line-number"><!-- placeholder --></div>',
          '<span class="line-content">'+line+'</span></span>',
        '</div>'
      ].join('');
    }).join('');
  });

  // make TOC sticky
  var $toc = $(".g-left-panel");
  if ($toc.length) {
    var stickyTop = $toc.offset().top - 100;
    $window.on('scroll', function(){
      ($window.scrollTop() >= stickyTop) ? $toc.addClass('d-fixed') : $toc.removeClass('d-fixed');
    });
  }

  $window.on('hashchange', correctHashScroll)
  correctHashScroll()

  function correctHashScroll() {
    var currentScroll = $document.scrollTop();
    var mastheadHeight = $('#masthead').outerHeight() + 15; // extra padding
    if (window.location.hash && currentScroll > mastheadHeight) {
      console.log('reducing scroll from ' + currentScroll)
      $document.scrollTop(currentScroll - mastheadHeight)
    }
  }

  function populateUserHistoryData() {
    $.ajax({
      method: 'GET',
      url: '/reading-history/docs.json',
      data: {
        limit: 4
      },
      json: true
    }).always(function(data) {
      var recentlyViewed = data.recentlyViewed;
      var mostViewed = data.mostViewed;

      addElements(recentlyViewed, {
        name: 'Recently Viewed',
        emptyText: "You've viewed no stories!"
      });

      addElements(mostViewed, {
        name: 'Most Viewed'
      });

      $('#me .popup .fa-spinner').remove();
    })
  }

  $html.one('mouseenter', '.user-tools', populateUserHistoryData);

  function addElements(data, elementAttributes) {
    var $target = $('#me .popup');

    if (!data || data.length == 0) {
      if (elementAttributes.emptyText) {
        $target.append(createTextElement('p', '', elementAttributes.emptyText));
      }
      return;
    }

    var items = data.map(function(el) {
      var item = el.doc || {};
      var folder = (item.folder || {}).prettyName || ''; // lets not try to show a folder if there isn't one

      var attr = createTextElement('p', 'docs-attr');
      attr.appendChild(createTextElement('span', 'docs-folder', folder));
      attr.appendChild(createTextElement('span', 'timestamp', '(' + el.lastViewed + ')'));

      var link = createTextElement('a');
      link.setAttribute('href', safeHref(item.path));
      link.appendChild(createTextElement('p', 'docs-title', item.prettyName));
      link.appendChild(attr);

      var li = createTextElement('li');
      li.appendChild(link);
      return li;
    });

    var className = elementAttributes.name.toLowerCase().replace(' ', '-') + '-content';

    var list = createTextElement('ul', className);
    items.forEach(function(li) { list.appendChild(li); });

     // perform all the DOM manipulation as a single operation
    $target.append([createTextElement('h3', '', elementAttributes.name), list]);
  }

  function filenameMatcher(q, cb) {
    const substrRegex = new RegExp(q, 'i')
    const filenames = getFilenameStorage().filenames
    cb(filenames.filter((str) => substrRegex.test(str)))
  }

  var $searchBox = $('#search-box')
  // setup typeahead
  $searchBox.typeahead({
    hilight: true
  }, {
    name: 'documents',
    source: filenameMatcher
  })

  // when the typeahead selects a result, immediately submit the form
  // and tell the backend it was an autocomplete so we can go there directly.
  $searchBox.on('typeahead:select', function (event, selectedItem) {
    var $form = $searchBox.closest('form')
    $form.append('<input type="hidden" name="autocomplete" value="1"/>')
    $form.submit()
  })
})


function personalizeHomepage(userId) {

  // Personalize the team listing on the left.
  // Most-frequently-visited teams are inserted at the top, then padded with default entries.
  fetchHistory('teams', userId, function(data) {
    var expectedLength = $('.teams-cat-list li').length
    var items = data.mostViewed.map(function(el) {
      var team = el.team || {}
      // kill existing elements that on the mostViewed list to avoid dupes
      $('ul.teams-cat-list li').filter(function() {
        return this.getAttribute('data-team-id') === String(team.id)
      }).detach()

      var link = createTextElement('a', 'button btn-cat', team.prettyName)
      link.setAttribute('href', safeHref(team.path))
      var li = createTextElement('li')
      li.appendChild(link)
      return li
    })

    $('ul.teams-cat-list').prepend(items)
    $('ul.teams-cat-list li:gt(' + (expectedLength - 1) + ')').detach()
  })

  /*
    This code swaps "Favorite Docs" into the "Useful Docs" panel if you have at least three favorites.
    We decided that we'll disable for v1 but perhaps incorporate after initial launch.

    fetchHistory('docs', userId, function(data) {
      var favorites = data.mostViewed.filter(function(el) {
        return el.viewCount > 5
      })

      if(favorites.length < 3) { return }

      var items = favorites.map(function (el) {
        var link = createTextElement('a', '', el.doc.prettyName)
        link.setAttribute('href', safeHref(el.doc.path))
        var li = createTextElement('li')
        li.appendChild(link)
        return li
      })

      $('.featured-cat-container h3').text('Favorite Docs')
      $('ul.featured-cat-list').empty().append(items)
    })
  */
}

// Drive names and paths are untrusted: never pass them through an HTML parser.
function createTextElement(tagName, className, text) {
  var el = document.createElement(tagName)
  if (className) el.className = className
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}

// Only http(s) URLs (including relative library paths) may be used as link targets.
function safeHref(path) {
  if (typeof path !== 'string' || !path) return '#'
  var url, parsed
  try {
    url = formatUrl(path)
    parsed = new URL(url, window.location.href)
  } catch (err) {
    return '#'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '#'
  if (parsed.origin === window.location.origin) return parsed.pathname + parsed.search + parsed.hash
  return parsed.href
}

function fetchHistory(type, userId, cb) {
  var key = "libraryHistory:" + userId + ':' + type
  var data

  if(data = localStorage.getItem(key)) {
    data = JSON.parse(data)

    // refresh localStorage data in the background if it's older than an hour
    if(!data.ts || new Date(data.ts) < (new Date() - 60 * 60 * 1000)) {
      refreshHistory(key, type)
    }

    return cb(data.history)
  } else {
    return refreshHistory(key, type, cb)
  }
}

function refreshHistory(localStorageKey, type, cb) {
  $.ajax('/reading-history/' + type + '.json?limit=5', {
    success: function(data) {
      localStorage.setItem(localStorageKey, JSON.stringify({ ts: new Date(), history: data }))
      if(cb) { return cb(data) }
    }
  })
}

// Adds a See More button for category containers with content
// that overflows a max height set in the css
function seeMoreButton() {
  $('.children-view').each(function (_, el) {
    var $el = $(el)
    var $content = $el.find('.children')
    if ($el.height() >= $content.height()) return

    $el.parent().append('<button class="seeMore-button">See more</button>')
  })

  $('#category-page').on('click', '.seeMore-button', function (el) {
    var $button = $(el.currentTarget)
    var text = $button.hasClass('show') ? 'See more' : 'See less'

    $button.toggleClass('show')
    $button.parent().find('.children-view').toggleClass('hide')
    $button.html(text)
  })
}
